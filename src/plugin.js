'use strict'

const crypto = require('crypto')
const shared = require('ilp-plugin-shared')
const bitcoin = require('./bitcoin')
const IncomingChannel = require('./incoming')
const OutgoingChannel = require('./outgoing')
const EventEmitter2 = require('eventemitter2')
const InvalidFieldsError = shared.Errors.InvalidFieldsError

module.exports = class PluginBitcoinPaychan extends EventEmitter2 {
  constructor ({
    incomingTxId,
    outgoingTxId,
    rpcUri,
    secret,
    timeout,
    network,
    outputIndex
    peerPublicKey,
    bitcoinUri,
    _store
  }) {
    super()

    if (!incomingTxId) {
      throw new InvalidFieldsError('missing opts.incomingTxId')
    } else if (!outgoingTxId) {
      throw new InvalidFieldsError('missing opts.outgoingTxId')
    } else if (!rpcUri) {
      throw new InvalidFieldsError('missing opts.rpcUri')
    } else if (!secret) {
      throw new InvalidFieldsError('missing opts.secret')
    } else if (!peerPublicKey) {
      throw new InvalidFieldsError('missing opts.peerPublicKey')
    } else if (!bitcoinUri) {
      throw new InvalidFieldsError('missing opts.bitcoinUri')
    } else if (!_store) {
      throw new InvalidFieldsError('missing opts._store')
    }

    this._incomingTxId = incomingTxId
    this._outgoingTxId = outgoingTxId
    this._bitcoinUri = bitcoinUri
    this._peerPublicKey = peerPublicKey
    this._secret = secret
    this._prefix = 'g.crypto.bitcoin.' + ((incomingTxId > outgoingTxId)
      ? incomingTxId + outgoingTxId
      : outgoingTxId + incomingTxId) + '.'

    // TODO: make the balance right, and have it be configurable
    this._inFlight = new shared.Balance({ store: _store })
    this._transfers = new shared.TransferLog({ store: _store })
    this._validator = new shared.Validator({ plugin: this })
    this._rpc = new shared.HttpRpc({
      rpcUri: rpcUri,
      plugin: this,
      // TODO: shared secret or something
      authToken: 'placeholder'
    })

    // incoming channel submits and validates claims
    this._incomingChannel = new IncomingChannel({
      txid: incomingTxId,
      uri: bitcoinUri
    })

    // outgoing channel generates claims and times out the channel
    this._outgoingChannel = new OutgoingChannel({
      txid: outgoingTxId,
      uri: bitcoinUri
      store: _store,
      receiverPublicKey: peerPublicKey,
      secret,
      timeout,
      network,
      outputIndex
    })

    this.receive = this._rpc.receive.bind(this._rpc)
    this._rpc.addMethod('send_message', this._handleSendMessage)
    this._rpc.addMethod('send_transfer', this._handleSendTransfer)
    this._rpc.addMethod('fulfill_condition', this._handleFulfillCondition)
    this._rpc.addMethod('reject_incoming_transfer', this._handleRejectIncomingTransfer)
  }

  async connect () {
    await this._incomingChannel.connect()
    await this._outgoingChannel.connect()
    shared.Util.safeEmit('connect')
  }

  async disconnect () {
    await this._incomingChannel.claim()  
    shared.Util.safeEmit('disconnect')
  }

  getAccount () {
    return this._prefix + bitcoin.toPublicKey(secret)
  }

  getInfo () {
    return {
      prefix: this._prefix,
      currencyCode: 'BTC',
      currencyScale: 8,
      connectors: [ this._prefix + this._peerPublicKey ]
    }
  }

  async sendMessage (_message) {
    const message = this._validator.normalizeOutgoingMessage(_message)
    await this._rpc.call('send_message', [ message ])
    shared.Utils.safeEmit(this, 'outgoing_message', message)
  }

  async _handleSendMessage (_message) {
    const message = this._validator.normalizeIncomingMessage(_message)
    shared.Utils.safeEmit(this, 'incoming_message', message)
    return true
  }

  async sendTransfer (_transfer) {
    const transfer = this._validator.normalizeOutgoingTransfer(_transfer)
    // TODO: wrap these into just one method
    const noRepeat = (this._transfers.cacheOutgoing(transfer) &&
      (await this._transfers.notInStore(transfer)))

    await this._rpc.call('send_transfer', this._prefix, [
      // TODO: util method for this?
      Object.assign({}, transfer, { noteToSelf: undefined })
    ])
    debug(transfer.id + ' acknowledged by peer')

    // TODO: is all this repeat stuff totally necessary?
    if (!noRepeat) return

    shared.Utils.safeEmit(this, 'outgoing_prepare', transfer)
    this._setupTransferExpiry(transfer.id, transfer.expiresAt)
  }

  async _handleSendTransfer (_transfer) {
    const transfer = this._validator.normalizeIncomingTransfer(_transfer)
    // TODO: wrap these into just one method
    const noRepeat = (this._transfers.cacheOutgoing(transfer) &&
      (await this._transfers.notInStore(transfer)))

    if (!noRepeat) return true

    await this._inFlight.add(transfer.amount)
      .catch((e) => {
        this._transfers.cancel(transfer.id)
        throw e
      })

    shared.Utils.safeEmit(this, 'incoming_prepare', transfer)
    this._setupTransferExpiry(transfer.id, transfer.expiresAt)
    return true
  }

  async fulfillCondition (transferId, fulfillment) {
    // TODO: check out that method
    this._validator.validateFulfillment(fulfillment)

    // TODO: what even is this construct and why did I do it
    const error = this._transfers.assertAllowedChange(transferId, 'executed')
    if (error) {
      await error
      await this._rpc.call('fulfill_condition', this._prefix, [ transferId, fulfillment ])
      return
    }

    // TODO: what does this do and is it needed?
    this._transfers.assertIncoming(transferId)
    // TODO: make the error on this better when the transfer isn't found
    const transfer = this._transfers.get(transferId)
    shared.Util.safeEmit(this, 'incoming_fulfill', transfer, fulfillment)
    
    let claim
    try {
      claim = await this.rpc.call('fulfill_condition', this._prefix, [transferId, fulfillment])
    } catch (e) {
      debug('failed to get claim from peer. keeping the in-flight balance up.')
      return
    }

    this._incomingChannel.processClaim({ transfer, claim })
  }

  async _handleFulfillCondition (transferId, fulfillment) {
    this._validator.validateFulfillment(fulfillment)

    const error = this._transfers.assertAllowedChange(transferId, 'executed')
    if (error) {
      await error
      // TODO: return an error instead, so it gives better error?
      return true
    }

    this._transfers.assertOutgoing(transferId)
    const transfer = this._transfers.get(transferId)

    this._validateFulfillment(fulfillment, transfer.executionCondition)
    this._transfers.fulfill(transferId, fulfillment)
    shared.Util.safeEmit(this, 'outgoing_fulfill', transfer, fulfillment)

    return this._outgoingChannel.createClaim({ transfer })
  }

  _validateFulfillment (fulfillment, condition) {
    const hash = shared.Util.base64url(crypto
      .createHash('sha256')
      .update(Buffer.from(fulfillment, 'base64'))
      .digest())

    // TODO: validate the condition to make sure it's base64url
    if (hash !== condition) {
      throw new NotAcceptedError('fulfillment ' + fulfillment +
        ' does not match condition ' + condition)
    }
  }

  async rejectIncomingTransfer (transferId, reason) {
    const error = this._transfers.assertAllowedChange(transferId, 'cancelled')
    if (error) {
      await error
      await this._rpc.call('reject_incoming_transfer', this._prefix, [transferId, reason])
      return
    }

    debug('rejecting', transfer.id)
    this._transfers.assertIncoming(transferId)
    const transfer = this._transfers.get(transferId)

    this._transfers.cancel(transferId)
    shared.Util.safeEmit(this, 'incoming_reject', transfer)
    await this._inFlight.sub(transfer.amount)
    await this._rpc.call('reject_incoming_transfer', this._prefix, [ transferId, reason ])
  }

  async _handleRejectIncomingTransfer (transferId, reason) {
    const error = this._transfers.assertAllowedChange(transferId, 'cancelled')
    if (error) {
      await error
      return true
    }

    this._transfers.assertOutgoing(transferId)
    const transfer = this._transfers.get(transferId)

    this._transfers.cancel(transferId)
    shared.Util.safeEmit(this, 'outgoing_reject', transfer)
    return true
  }

  _setupTransferExpiry (transferId, expiresAt) {
    const expiry = Date.parse(expiresAt)
    const now = Date.now()

    setTimeout(
      this._expireTransfer.bind(this, transferId),
      (expiry - now))
  }

  async _expireTransfer (transferId) {
    debug('checking expiry on ' + transferId)

    // TODO: use a less confusing construct
    try {
      const error = this._transfers.assertAllowedChange(transferId, 'cancelled')
      if (error) {
        await error
        return
      }
    } catch (e) {
      debug(e.message)
      return
    }

    const cached = this._transfers._getCachedTransferWithInfo(transferId)
    this._transfers.cancel(transferId)

    if (cached.isIncoming) {
      this._inFlight.sub(cached.transfer.amount)
    }

    this._safeEmit((cached.isIncoming ? 'incoming' : 'outgoing') + '_cancel',
      cached.transfer)
  }
}
