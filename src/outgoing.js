'use strict'

const url = require('url')
const shared = require('ilp-plugin-shared')
const bitcoin = require('./bitcoin')
const BitcoinClient = require('bitcoin-core')
const BigInteger = require('bigi')
const bitcoinjs = require('bitcoinjs-lib')

module.exports = class OutgoingChannel {
  constructor ({
    txid,
    uri,
    store,
    secret,
    receiverPublicKey,
    timeout,
    network,
    outputIndex
  }) {
    // TODO: modify balance class to support several balances in one store
    // TODO: set max amount better
    this._balance = new shared.Balance({ store, maximum: 5 })
    this._secret = secret
    this._senderKeypair = bitcoin.secretToKeypair(this._secret)
    this._receiverKeypair = bitcoin.publicToKeypair(receiverPublicKey)
    this._timeout = timeout
    this._network = network
    this._outputIndex = outputIndex
    this._bitcoinUri = url.parse(uri)
    this._txid = txid
  }

  async connect () {
    const [ user, pass ] = this._bitcoinUri.auth.split(':')
    console.log(user, pass)
    await this._balance.connect()
    this._client = new BitcoinClient({
      // TODO: make this optional
      network: this._network,
      // host: this._bitcoinUri.host,
      // port: this._bitcoinUri.port,
      ssl: ((this._bitcoinUri.protocol === 'https:')
        ? { enabled: true, strict: true }
        : false),
      username: user,
      password: pass
    })

    const tx = await this._client.command('gettransaction', this._txid)
    const scriptOpts = {
      senderKeypair: this._senderKeypair,
      receiverKeypair: this._receiverKeypair,
      timeout: this._timeout,
      // TODO: omit undefined?
      network: this._network
    }

    // this._redeemScript = bitcoin.generateRedeemScript(scriptOpts)
    this._redeemScript = bitcoin.generateScript(scriptOpts)

    // TODO: set the max to the amount in the channel
    // const tx = await this._client.command('getblockchaininfo')
    // TODO: validation on the transaction
    // console.log(tx)
  }

  async createClaim (transfer) {
    await this._balance.add(transfer.amount)

    const transaction = bitcoin.generateRawClosureTx({
      receiverKeypair: this._receiverKeypair,
      senderKeypair: this._senderKeypair,
      txid: this._txid,
      outputIndex: this._outputIndex,
      claimAmount: this._balance.get(),
      // TODO: properly calculate amount
      changeAmount: (5 - this._balance.get())
    })

    return bitcoin.getClosureTxSigned({
      keypair: this._senderKeypair,
      redeemScript: this._redeemScript,
      transaction: transaction
    })
  }

  async expire () {

  }
}
