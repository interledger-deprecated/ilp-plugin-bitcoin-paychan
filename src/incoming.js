const url = require('url')
const shared = require('ilp-plugin-shared')
const bitcoin = require('./bitcoin')
const BitcoinClient = require('bitcoin-core')
const BigInteger = require('bigi')
const bitcoinjs = require('bitcoinjs-lib')

module.exports = class IncomingChannel {
  constructor ({
    txid,
    uri,
    store,
    secret,
    senderPublicKey,
    timeout,
    network,
    outputIndex
  }) {
    // TODO: modify balance class to support several balances in one store
    // TODO: set max amount better
    this._balance = new shared.Balance({ store, maximum: 5 })
    this._secret = secret
    this._senderKeypair = bitcoin.publicToKeypair(senderPublicKey)
    this._receiverKeypair = bitcoin.secretToKeypair(this._secret)
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
      network: this._network,
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
      network: this._network
    }

    this._redeemScript = bitcoin.generateScript(scriptOpts)
    // TODO: set the max to the amount in the channel
    // TODO: validation on the transaction
  }

  async processClaim ({ transfer, claim }) {
    // TODO: validation on the claim
    // TODO: adjust the balance

    this._claim = claim
  }

  async claim () {
    if (!this._claim) throw new Error('No claim to submit')

    console.log('generating raw closure tx')
    const transaction = bitcoin.generateRawClosureTx({
      receiverKeypair: this._receiverKeypair,
      senderKeypair: this._senderKeypair,
      txid: this._txid,
      outputIndex: this._outputIndex,
      // claimAmount: this._balance.get(),
      // TODO: properly calculate amount
      // changeAmount: (5 - this._balance.get())
      claimAmount: 3,
      changeAmount: 2
    })
    console.log('raw transation:', transaction.toBuffer().toString('hex'))

    console.log('generating receiver signature')
    const receiverSig = bitcoin.getClosureTxSigned({
      keypair: this._receiverKeypair,
      redeemScript: this._redeemScript,
      transaction: transaction
    })

    console.log('generating the script that does the stuff')
    console.log('redeem to buffer:', this._redeemScript.toString('hex'))
    const closeScript = bitcoinjs.script.scriptHash.input.encode([
      Buffer.from(this._claim, 'hex'),
      Buffer.from(receiverSig, 'hex'),
      bitcoinjs.opcodes.OP_FALSE
    ], this._redeemScript)

    console.log('setting it to be the input script')
    transaction.setInputScript(0, closeScript)

    console.log('logging it now')
    console.log(transaction.toBuffer().toString('hex'))
  }
}
