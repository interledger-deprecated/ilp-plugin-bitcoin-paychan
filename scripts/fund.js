'use strict'

const bitcoinjs = require('bitcoinjs-lib')
const bitcoin = require('../src/bitcoin')
const [ , , senderPublicKey, receiverPublicKey, timeout, network ] = process.argv

if (process.argv.length < 5) {
  console.error('usage: node fund.js',
    '<senderPublicKey> <receiverPublicKey> <timeout> [network]')
  process.exit(1)
}

const senderKeypair = bitcoin.publicToKeypair(senderPublicKey)
const receiverKeypair = bitcoin.publicToKeypair(receiverPublicKey)

try {
  console.log('sender to receiver channel:', bitcoin.generateP2SH({
    senderKeypair,
    receiverKeypair,
    timeout: +timeout,
    network: bitcoinjs.networks[network]
  }))

  console.log('receiver to sender channel:', bitcoin.generateP2SH({
    senderKeypair: receiverKeypair,
    receiverKeypair: senderKeypair,
    timeout: +timeout,
    network: bitcoinjs.networks[network]
  }))
} catch (e) {
  console.error(e)
}
