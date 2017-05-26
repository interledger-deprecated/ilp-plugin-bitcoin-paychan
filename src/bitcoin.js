'use strict'

const bitcoinjs = require('bitcoinjs-lib')
const BigInteger = require('bigi')
const BitcoinClient = require('bitcoin-core')
const url = require('url')

const BTC_SCALE = 1e8
const DEFAULT_FEE = 1e5
const FINAL_SEQUENCE = 0xfffffffe
const HASH_ALL = 1

function getClient ({ uri, network }) {
  const _uri = url.parse(uri)
  const [ user, pass ] = _uri.auth.split(':')

  return new BitcoinClient({
    network: network,
    host: _uri.hostname,
    ssl: ((uri.protocol === 'https:')
      ? { enabled: true, strict: true }
      : false),
    username: user,
    password: pass
  })
}

async function getTx (client, txid) {
  const tx = await client.command('getrawtransaction', txid)
  return bitcoinjs.Transaction.fromBuffer(Buffer.from(tx, 'hex'))
}

function publicKeyToAddress (publicKey) {
  return bitcoinjs.ECPair
    .fromPublicKeyBuffer(Buffer.from(publicKey, 'hex'), bitcoinjs.networks.testnet)
    .getAddress()
}

function scriptToOut (script) {
  return bitcoinjs.script.scriptHash.output.encode(bitcoinjs.crypto.hash160(script))
}

async function submit (client, transactionHex) {
  console.log('submitting raw transaction to bitcoin core')
  const txid = await client.command('sendrawtransaction', transactionHex, true)
  console.log('submitted with txid:', txid)
}

async function createTx ({
  client,
  script,
  amount
}) {
  const address = scriptToP2SH({ script, network: bitcoinjs.networks.testnet })
  console.log('sending to address', address, 'with amount', amount)
  return await client.command('sendtoaddress', address, amount / BTC_SCALE)
}

function scriptToP2SH ({
  script,
  network
}) {
  const scriptPubKey = bitcoinjs.script.scriptHash.output.encode(bitcoinjs.crypto.hash160(script))
  return bitcoinjs.address.fromOutputScript(scriptPubKey, network)
}

function generateP2SH ({
  senderKeypair,
  receiverKeypair,
  timeout,
  network
}) {
  const script = generateScript({
    senderKeypair,
    receiverKeypair,
    timeout,
    network
  })

  return scriptToP2SH({ script, network })
}

function generateRawClosureTx ({
  receiverKeypair,
  senderKeypair,
  txid,
  outputIndex,
  claimAmount,
  changeAmount,
  fee
}) {
  // TODO: is this an appropriate fee?
  // TODO: support other networks
  const _fee = fee || DEFAULT_FEE
  const tx = new bitcoinjs.TransactionBuilder(bitcoinjs.networks.testnet)

  tx.addInput(txid, outputIndex)
  tx.addOutput(receiverKeypair.getAddress(), +claimAmount)
  tx.addOutput(senderKeypair.getAddress(), +changeAmount - _fee)

  return tx.buildIncomplete()
}

function generateExpireTx ({
  senderKeypair,
  txid,
  outputIndex,
  timeout,
  amount,
  fee
}) {
  const _fee = fee || DEFAULT_FEE
  const tx = new bitcoinjs.TransactionBuilder(bitcoinjs.networks.testnet)

  tx.setLockTime(timeout)
  tx.addInput(txid, outputIndex, FINAL_SEQUENCE)
  tx.addOutput(senderKeypair.getAddress(), amount - _fee)

  return tx.buildIncomplete()
}

function getTxHash (transaction, redeemScript) {
  const inputIndex = 0
  return transaction.hashForSignature(inputIndex, redeemScript, HASH_ALL)
}

function getClosureTxSigned ({
  keypair,
  redeemScript,
  transaction
}) {
  const inputIndex = 0
  const hash = getTxHash(transaction, redeemScript)
  return keypair
    .sign(hash)
    .toScriptSignature(HASH_ALL)
    .toString('hex')
}

function generateScript ({
  senderKeypair,
  receiverKeypair,
  timeout,
  network
}) {
  if (!timeout) throw new Error('script requires a timeout, got: ' + timeout)
  return bitcoinjs.script.compile([
    bitcoinjs.opcodes.OP_IF,
    bitcoinjs.script.number.encode(timeout),
    bitcoinjs.opcodes.OP_CHECKLOCKTIMEVERIFY,
    bitcoinjs.opcodes.OP_DROP,

    bitcoinjs.opcodes.OP_ELSE,
    receiverKeypair.getPublicKeyBuffer(),
    bitcoinjs.opcodes.OP_CHECKSIGVERIFY,
    bitcoinjs.opcodes.OP_ENDIF,

    senderKeypair.getPublicKeyBuffer(),
    bitcoinjs.opcodes.OP_CHECKSIG
  ])
}

function secretToKeypair (secret) {
  return new bitcoinjs.ECPair(
    BigInteger.fromBuffer(Buffer.from(secret, 'hex')),
    null,
    { network: bitcoinjs.networks.testnet })
}

function publicToKeypair (publicKey) {
  return bitcoinjs.ECPair
    .fromPublicKeyBuffer(Buffer.from(publicKey, 'hex'), bitcoinjs.networks.testnet)
}

module.exports = {
  publicKeyToAddress,
  generateP2SH,
  generateRawClosureTx,
  generateExpireTx,
  getClosureTxSigned,
  generateScript,
  secretToKeypair,
  publicToKeypair,
  getClient,
  getTx,
  scriptToOut,
  getTxHash,
  createTx,
  submit
}
