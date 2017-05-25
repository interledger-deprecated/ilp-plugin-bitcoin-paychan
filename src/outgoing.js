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
    this._balance = new shared.Balance({ store, maximum: 0 })
    this._secret = secret
    this._timeout = timeout
    this._network = network
    this._outputIndex = outputIndex
    this._bitcoinUri = url.parse(uri)
    this._txid = txid
  }

  async connect () {
    await this._balance.connect()

    this._client = bitcoin.getClient({
      uri: this._bitcoinUri,
      network: this._network
    })

    this._tx = await this._client.command('gettransaction', this._txid)
    this._redeemScript = bitcoin.generateScript({
      senderKeypair: this._senderKeypair,
      receiverKeypair: this._receiverKeypair,
      timeout: this._timeout,
      network: this._network
    })

    const out = this._tx.outs[this._outputIndex]
    const outValue = out.value
    const outScript = out.script
    const redeemScriptOut = bitcoin.scriptToOut(this._redeemScript)

    if (outScript !== redeemScriptOut) {
      throw new Error('output script (' + outScript.toString('hex') + ') does not match' +
        'redeem script output (' + redeemScriptOut.toString('hex') + ').')
    }

    this._balance.setMaximum(outValue)
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

    console.log('redeem script:', this._redeemScript.toString('hex'))
    console.log('keypair:', this._senderKeypair.toWIF())

    return bitcoin.getClosureTxSigned({
      keypair: this._senderKeypair,
      redeemScript: this._redeemScript,
      transaction: transaction
    })
  }

  async expire () {
    const transaction = bitcoin.generateExpireTx({
      senderKeypair: this._senderKeypair,
      txid: this._txid,
      outputIndex: this._outputIndex,
      timeout: this._timeout,
      // TODO: properly calculate amount
      amount: 5
    })

    console.log('transaction:', transaction.toBuffer().toString('hex'))
    console.log('redeem script:', this._redeemScript.toString('hex'))
    console.log('keypair:', this._senderKeypair.toWIF())

    const senderSig = bitcoin.getClosureTxSigned({
      keypair: this._senderKeypair,
      redeemScript: this._redeemScript,
      transaction: transaction
    })
    console.log('sending signature:', senderSig)
    console.log('is it canonical?', bitcoinjs.script.isCanonicalSignature(Buffer.from(senderSig, 'hex')))

    const expireScript = bitcoinjs.script.scriptHash.input.encode([
      Buffer.from(senderSig, 'hex'),
      bitcoinjs.opcodes.OP_TRUE
    ], this._redeemScript)

    transaction.setInputScript(0, expireScript)
    console.log(transaction.toBuffer().toString('hex'))
  }
}
