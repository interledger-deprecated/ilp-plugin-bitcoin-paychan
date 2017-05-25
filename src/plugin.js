'use strict'

const debug = require('debug')('ilp-plugin-bitcoin-paychan')
const crypto = require('crypto')
const shared = require('ilp-plugin-shared')
const bitcoin = require('./bitcoin')
const Channel = require('./channel')
const EventEmitter2 = require('eventemitter2')
const InvalidFieldsError = shared.Errors.InvalidFieldsError

module.exports = class PluginBitcoinPaychan extends EventEmitter2 {
  constructor ({
    outgoingAmount,
    rpcUri,
    secret,
    timeout,
    network,
    peerPublicKey,
    bitcoinUri,
    maxInFlight,
    _store,
  }) {
    super()

    if (!rpcUri) {
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

    this._bitcoinUri = bitcoinUri
    this._peerPublicKey = peerPublicKey
    this._secret = secret
    this._keypair = bitcoin.secretToKeypair(this._secret)
    this._address = bitcoin.publicKeyToAddress(this._keypair.getPublicKeyBuffer().toString('hex'))
    this._peerAddress = bitcoin.publicKeyToAddress(peerPublicKey)

    this._prefix = 'g.crypto.bitcoin.' + ((this._address > this._peerAddress)
      ? this._address + '~' + this._peerAddress
      : this._peerAddress + '~' + this._address) + '.'

    // TODO: make the balance right, and have it be configurable
    this._inFlight = new shared.Balance({ store: _store, maximum: maxInFlight })
    this._transfers = new shared.TransferLog({ store: _store })
    this._validator = new shared.Validator({ plugin: this })
    this._rpc = new shared.HttpRpc({
      rpcUri: rpcUri,
      plugin: this,
      // TODO: shared secret or something
      authToken: 'placeholder'
    })

    const channelParams = {
      // TODO: allow 2 different timeouts?
      timeout: timeout,
      uri: this._bitcoinUri,
      store: _store,
      network: 'testnet',
      secret: this._secret
    }

    // incoming channel submits and validates claims
    this._incomingChannel = new Channel(Object.assign({
      senderPublicKey: this._peerPublicKey
    }, channelParams))

    // outgoing channel generates claims and times out the channel
    this._outgoingChannel = new Channel(Object.assign({
      receiverPublicKey: this._peerPublicKey,
      amount: outgoingAmount
    }, channelParams))

    this.receive = this._rpc.receive.bind(this._rpc)
    this._rpc.addMethod('send_message', this._handleSendMessage)
    this._rpc.addMethod('send_transfer', this._handleSendTransfer)
    this._rpc.addMethod('fulfill_condition', this._handleFulfillCondition)
    this._rpc.addMethod('reject_incoming_transfer', this._handleRejectIncomingTransfer)
    this._rpc.addMethod('get_outgoing_txid', this._handleGetOutgoingTxId)
  }

  async _handleGetOutgoingTxId () {
    return this._outgoingTxId
  }

  async connect () {
    await this._inFlight.connect()
    await this._incomingChannel.connect()
    await this._outgoingChannel.connect()
    this._outgoingTxId = await this._outgoingChannel.createChannel()

    while (!this._incomingTxId) {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      this._incomingTxId = await this._rpc.call('get_outgoing_txid', this._prefix, [])
    }

    await this._incomingChannel.loadTransaction({ txid: this._incomingTxId })
    shared.Util.safeEmit(this, 'connect')
  }

  async disconnect () {
    await this._incomingChannel.claim()  
    shared.Util.safeEmit(this, 'disconnect')
  }

  getAccount () {
    return this._prefix + this._address
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
    await this._rpc.call('send_message', this._prefix, [ message ])
    shared.Util.safeEmit(this, 'outgoing_message', message)
  }

  async _handleSendMessage (_message) {
    const message = this._validator.normalizeIncomingMessage(_message)
    shared.Util.safeEmit(this, 'incoming_message', message)
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

    shared.Util.safeEmit(this, 'outgoing_prepare', transfer)
    this._setupTransferExpiry(transfer.id, transfer.expiresAt)
  }

  async _handleSendTransfer (_transfer) {
    const transfer = this._validator.normalizeIncomingTransfer(_transfer)
    // TODO: wrap these into just one method
    const noRepeat = (this._transfers.cacheIncoming(transfer) &&
      (await this._transfers.notInStore(transfer)))

    if (!noRepeat) return true

    await this._inFlight.add(transfer.amount)
      .catch((e) => {
        this._transfers.cancel(transfer.id)
        throw e
      })

    shared.Util.safeEmit(this, 'incoming_prepare', transfer)
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
      claim = await this._rpc.call('fulfill_condition', this._prefix, [transferId, fulfillment])
    } catch (e) {
      debug('failed to get claim from peer. keeping the in-flight balance up.')
      return
    }

    debug('got claim from peer:', claim)
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
    console.log('fetched transfer for fulfill:', transfer)

    this._validateFulfillment(fulfillment, transfer.executionCondition)
    this._transfers.fulfill(transferId, fulfillment)
    shared.Util.safeEmit(this, 'outgoing_fulfill', transfer, fulfillment)

    const sig = await this._outgoingChannel.createClaim(transfer)
    console.log('produced claim:', sig)
    return sig
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

    shared.Util.safeEmit(this, (cached.isIncoming ? 'incoming' : 'outgoing') + '_cancel',
      cached.transfer)
  }
}
