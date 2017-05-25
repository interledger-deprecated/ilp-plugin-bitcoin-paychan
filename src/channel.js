const url = require('url')
const shared = require('ilp-plugin-shared')
const bitcoin = require('./bitcoin')
const BigInteger = require('bigi')
const bitcoinjs = require('bitcoinjs-lib')
const debug = require('debug')('ilp-plugin-bitcoin-paychan:channel')

module.exports = class Channel {
  constructor ({
    uri,
    store,
    secret,
    senderPublicKey,
    receiverPublicKey,
    timeout,
    network,
    amount,
    outputIndex
  }) {
    this._secret = secret
    if (senderPublicKey) {
      this._receiverKeypair = bitcoin.secretToKeypair(this._secret)
      this._senderKeypair = bitcoin.publicToKeypair(senderPublicKey)
      this._incoming = true
    } else {
      this._senderKeypair = bitcoin.secretToKeypair(this._secret)
      this._receiverKeypair = bitcoin.publicToKeypair(receiverPublicKey)
      this._amount = amount
      this._incoming = false
    }

    this._timeout = timeout
    this._network = network
    this._bitcoinUri = url.parse(uri)
    this._balance = new shared.Balance({
      store,
      maximum: amount || 0,
      key: this._incoming ? 'incoming' : 'outgoing'
    })
  }

  async connect () {
    await this._balance.connect()

    this._client = bitcoin.getClient({
      uri: this._bitcoinUri,
      network: this._network
    })

    this._redeemScript = bitcoin.generateScript({
      senderKeypair: this._senderKeypair,
      receiverKeypair: this._receiverKeypair,
      timeout: this._timeout,
      // network: this._network
      network: bitcoinjs.networks.testnet
    })
  }

  async createChannel () {
    this._txid = await bitcoin.createTx({
      client: this._client,
      script: this._redeemScript,
      amount: this._amount
    })

    debug('created fund transaction with id', this._txid)
    return this._txid
  }

  async loadTransaction ({ txid }) {
    this._txid = txid
    debug('loading fund transaction with id', this._txid)
    this._tx = await bitcoin.getTx(this._client, this._txid)

    for (const out of this._tx.outs) {
      const outValue = out.value
      const outScript = out.script.toString('hex')
      const redeemScriptOut = bitcoin.scriptToOut(this._redeemScript).toString('hex')

      if (outScript !== redeemScriptOut) {
        continue
      }

      this._balance.setMaximum(outValue)
      return
    }

    throw new Error('outputs (' + this._tx.outs + ') do not include' +
      ' p2sh of redeem script output (' + redeemScriptOut.toString('hex') + ').')
  }

  _generateRawClosureTx () {
    return bitcoin.generateRawClosureTx({
      receiverKeypair: this._receiverKeypair,
      senderKeypair: this._senderKeypair,
      txid: this._txid,
      outputIndex: this._outputIndex,
      claimAmount: this._balance.get(),
      changeAmount: this._balance.getMaximum()
        .sub(this._balance.get())
        .toString()
    })
  }

  _signTx (transaction) {
    return bitcoin.getClosureTxSigned({
      keypair: this._senderKeypair,
      redeemScript: this._redeemScript,
      transaction
    })
  }

  async processClaim ({ transfer, claim }) {
    await this._balance.add(transfer.amount)
    const hash = bitcoin.getTxHash(this._generateRawClosureTx(), this._redeemScript)
    const sig = bitcoinjs.ECSignature.parseScriptSignature(Buffer.from(claim, 'hex'))

    if (!this._senderKeypair.verify(hash, sig.signature)) {
      this._balance.sub(transfer.amount)
      throw new Error('claim (' + claim + ') does not match signature hash (' +
        hash + ')')
    }

    debug('set new claim (' + claim + ') for amount', this._balance.get())
    this._claim = claim
  }

  async createClaim (transfer) {
    await this._balance.add(transfer.amount)

    const transaction = this._generateRawClosureTx()

    console.log('redeem script:', this._redeemScript.toString('hex'))
    console.log('keypair:', this._senderKeypair.toWIF())

    return this._signTx(transaction)
  }

  async claim () {
    if (!this._claim) throw new Error('No claim to submit')

    console.log('generating raw closure tx')
    const transaction = this._generateRawClosureTx()
    console.log('raw transation:', transaction.toBuffer().toString('hex'))

    console.log('generating receiver signature')
    const receiverSig = this._signTx(transaction)

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
    // TODO: really submit
    console.log('SUBMIT:', transaction.toBuffer().toString('hex'))
  }

  async expire () {
    const transaction = bitcoin.generateExpireTx({
      senderKeypair: this._senderKeypair,
      txid: this._txid,
      outputIndex: this._outputIndex,
      timeout: this._timeout,
      amount: +this._balance.getMaximum().toString()
    })

    console.log('transaction:', transaction.toBuffer().toString('hex'))
    console.log('redeem script:', this._redeemScript.toString('hex'))
    console.log('keypair:', this._senderKeypair.toWIF())

    const senderSig = this._signTx(transaction)
    console.log('sending signature:', senderSig)
    console.log('is it canonical?', bitcoinjs.script.isCanonicalSignature(Buffer.from(senderSig, 'hex')))

    const expireScript = bitcoinjs.script.scriptHash.input.encode([
      Buffer.from(senderSig, 'hex'),
      bitcoinjs.opcodes.OP_TRUE
    ], this._redeemScript)

    transaction.setInputScript(0, expireScript)
    // TODO: really submit
    console.log('SUBMIT:', transaction.toBuffer().toString('hex'))
  }
}
