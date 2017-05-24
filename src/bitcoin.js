'use strict'

const bitcoinjs = require('bitcoinjs-lib')
const BigInteger = require('bigi')

function publicKeyToAddress (publicKey) {
  return bitcoinjs.ECPair
    .fromPublicKeyBuffer(Buffer.from(publicKey, 'hex'), bitcoinjs.networks.testnet)
    .getAddress()
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

  const scriptPubKey = bitcoinjs.script.scriptHash.output.encode(bitcoinjs.crypto.hash160(script))
  return bitcoinjs.address.fromOutputScript(scriptPubKey, network)
}

function generateRawClosureTx ({
  receiverKeypair,
  senderKeypair,
  txid,
  outputIndex,
  claimAmount,
  changeAmount
}) {
  // TODO: support other networks
  const tx = new bitcoinjs.TransactionBuilder(bitcoinjs.networks.testnet)
  tx.addInput(txid, outputIndex)
  tx.addOutput(receiverKeypair.getAddress(), +claimAmount * 100000000)
  tx.addOutput(senderKeypair.getAddress(),   changeAmount * 100000000 - 10000)

  return tx.buildIncomplete()
}

function generateExpireTx ({
  senderKeypair,
  txid,
  outputIndex,
  amount
}) {
  const tx = new bitcoinjs.TransactionBuilder(bitcoinjs.networks.testnet)
  tx.addInput(txid, outputIndex)
  tx.addOutput(senderKeypair.getAddress(), amount * 100000000 - 10000)
}

function getClosureTxSigned ({
  keypair,
  redeemScript,
  transaction
}) {
  const hash = transaction.hashForSignature(0, redeemScript, 1)
  return keypair
    .sign(hash)
    .toScriptSignature(1)
    .toString('hex')
}

function generateScript ({
  senderKeypair,
  receiverKeypair,
  timeout,
  network
}) {
  return bitcoinjs.script.compile([
    bitcoinjs.opcodes.OP_IF,
    bitcoinjs.script.number.encode(timeout),
    bitcoinjs.opcodes.OP_CHECKSEQUENCEVERIFY,
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
  getClosureTxSigned,
  generateScript,
  secretToKeypair,
  publicToKeypair
}
