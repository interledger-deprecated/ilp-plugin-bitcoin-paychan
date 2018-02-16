'use strict'

const debug = require('debug')('ilp-plugin-bitcoin-paychan')
const crypto = require('crypto')
const BigNumber = require('bignumber.js')
const bitcoin = require('./bitcoin')
const Channel = require('./channel')
const PluginBtp = require('ilp-plugin-btp')
const BtpPacket = require('btp-packet')
const GET_OUTGOING_TXID = '_get_bitcoin_outgoing_txid'

class PluginBitcoinPaychan extends PluginBtp {
  constructor ({
    outgoingAmount,
    secret,
    timeout,
    network,
    peerPublicKey,
    bitcoinUri,
    _store,

    _incomingTxId, // Used by test.js
    _outgoingTxId, // Used by test.js

    listener,
    server
  }) {
    if (!listener && !server) {
      throw new Error('missing opts.listener or opts.server')
    } else if (!secret) {
      throw new Error('missing opts.secret')
    } else if (!peerPublicKey) {
      throw new Error('missing opts.peerPublicKey')
    } else if (!bitcoinUri) {
      throw new Error('missing opts.bitcoinUri')
    } else if (!_store) {
      throw new Error('missing opts._store')
    }

    super({listener, server})
    this._bitcoinUri = bitcoinUri
    this._peerPublicKey = peerPublicKey
    this._secret = secret
    this._keypair = bitcoin.secretToKeypair(this._secret)
    this._address = bitcoin.publicKeyToAddress(this._keypair.getPublicKeyBuffer().toString('hex'))
    this._peerAddress = bitcoin.publicKeyToAddress(peerPublicKey)

    this._prefix = 'g.crypto.bitcoin.' + ((this._address > this._peerAddress)
      ? this._address + '~' + this._peerAddress
      : this._peerAddress + '~' + this._address) + '.'

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

    this._incomingTxId = _incomingTxId
    this._outgoingTxId = _outgoingTxId
    this._bestClaimAmount = '0'
  }

  async _connect () {
    await this._incomingChannel.connect()
    await this._outgoingChannel.connect()
    if (!this._outgoingTxId) {
      this._outgoingTxId = await this._outgoingChannel.createChannel()
    }

    while (!this._incomingTxId) {
      await new Promise((resolve) => setTimeout(resolve, 5000))
      try {
        const res = await this._call(null, {
          type: BtpPacket.TYPE_MESSAGE,
          requestId: await _requestId(),
          data: {
            protocolData: [{
              protocolName: GET_OUTGOING_TXID,
              contentType: BtpPacket.MIME_APPLICATION_OCTET_STREAM,
              data: Buffer.alloc(0)
            }]
          }
        })
        const proto = res.protocolData.find((p) => p.protocolName === GET_OUTGOING_TXID)
        this._incomingTxId = JSON.parse(proto.data.toString()).txid
      } catch (e) {
        debug('got btp error:', e.message)
        debug('retrying...')
      }
    }

    await this._incomingChannel.loadTransaction({ txid: this._incomingTxId })
    await this._outgoingChannel.loadTransaction({})
  }

  async _disconnect () {
    if (this._incomingChannel._claim) {
      await this._incomingChannel.claim()
    }
  }

  async sendMoney (amount) {
    const claim = await this._outgoingChannel.createClaim({amount})
    await this._call(null, {
      type: BtpPacket.TYPE_TRANSFER,
      requestId: await _requestId(),
      data: {
        amount,
        protocolData: [{
          protocolName: 'claim',
          contentType: BtpPacket.MIME_APPLICATION_JSON,
          data: Buffer.from(JSON.stringify({ amount, signature: claim }))
        }]
      }
    })
  }

  async _handleMoney (from, { requestId, data }) {
    const transferAmount = new BigNumber(data.amount)
    const primary = data.protocolData[0]
    if (primary.protocolName !== 'claim') return []

    const lastAmount = new BigNumber(this._bestClaimAmount)
    const {amount, signature} = JSON.parse(primary.data)
    const addedMoney = new BigNumber(amount).minus(lastAmount)
    if (!addedMoney.eq(transferAmount)) {
      debug('amounts out of sync. peer thinks they sent ' + transferAmount.toString() + ' got ' + addedMoney.toString())
    }
    if (lastAmount.gte(amount)) {
      throw new Error('claim decreased')
    }

    await this._incomingChannel.processClaim({ transfer: {amount}, claim: signature })
    this._bestClaimAmount = amount

    if (this._moneyHandler) {
      await this._moneyHandler(addedMoney.toString())
    }
    return []
  }

  async _handleData (from, { requestId, data }) {
    const { protocolMap } = this.protocolDataToIlpAndCustom(data)
    if (!protocolMap[GET_OUTGOING_TXID]) {
      return super._handleData(from, { requestId, data })
    }
    return [{
      protocolName: GET_OUTGOING_TXID,
      contentType: BtpPacket.MIME_APPLICATION_JSON,
      data: Buffer.from(JSON.stringify({ txid: this._outgoingTxId }))
    }]
  }
}

PluginBitcoinPaychan.version = 2
module.exports = PluginBitcoinPaychan

async function _requestId () {
  return new Promise((resolve, reject) => {
    crypto.randomBytes(4, (err, buf) => {
      if (err) reject(err)
      resolve(buf.readUInt32BE(0))
    })
  })
}
