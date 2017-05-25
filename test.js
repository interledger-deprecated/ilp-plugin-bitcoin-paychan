'use strict'
const PluginBitcoin = require('.')
const bitcoin = require('./src/bitcoin')
const btc = require('bitcoinjs-lib')
const child = require('child_process')
const Koa = require('koa')
const Router = require('koa-router')
const Parser = require('koa-bodyparser')
const chalk = require('chalk')

const makeRpcCallback = function (plugin) {
  return async function (ctx) {
    const { method, prefix } = ctx.query

    try {
      ctx.body = plugin.receive(method, ctx.request.body)
    } catch (e) {
      ctx.body = e.stack
      ctx.status = 400
    }
  }
}

const establishRpc = function ({
  port, alice, bob
}) {
  const app = new Koa()
  const router = Router()
  const parser = Parser()

  router.post('/alice', makeRpcCallback(alice))
  router.post('/bob', makeRpcCallback(bob))

  app
    .use(parser)
    .use(router.routes())
    .use(router.allowedMethods())
    .listen(port)
}

const jankyRun = function (command) {
  return new Promise((resolve, reject) => {
    child.exec(command, function (err, stdout, stderr) {
      console.error(stderr)
      if (err) reject(err)
      console.log('"' + command + '" -> "' + stdout.trim() + '"')
      resolve(stdout.trim())
    })
  })
}

async function run () {
  const timeoutstamp = Date.now() / 1000

  console.log(chalk.grey('set timeout to ' + timeoutstamp))
  console.log(chalk.grey('generating channel addresses'))
  const secretAlice = '3b6386909838945a840b26c10fc794b1a536ea1ab02c162ecb62d565e24ed94a'
  const secretBob = '80044da2f41364353b173aacc42b8694125cda4636a979105c400e4d6bf4684f'
  const kpA = bitcoin.secretToKeypair(secretAlice)
  const kpB = bitcoin.secretToKeypair(secretBob)
  const addrAB = bitcoin.generateP2SH({
    senderKeypair: kpA,
    receiverKeypair: kpB,
    timeout: timeoutstamp,
    network: btc.networks.testnet
  })
  const addrBA = bitcoin.generateP2SH({
    senderKeypair: kpB,
    receiverKeypair: kpA,
    timeout: timeoutstamp,
    network: btc.networks.testnet
  })
  
  console.log(chalk.grey('funding channels'))
  const txAB = await jankyRun('bitcoin-cli -regtest sendtoaddress ' + addrAB + ' 1.00')
  const txBA = await jankyRun('bitcoin-cli -regtest sendtoaddress ' + addrBA + ' 1.00')

  console.log(chalk.grey('mining fund transactions'))
  await jankyRun('bitcoin-cli -regtest generate 1')

  console.log(chalk.grey('creating alice'))
  const alice = new PluginBitcoin({
    incomingTxId: txBA,
    outgoingTxId: txAB,
    // TODO: maybe these are wrong sometimes
    incomingOutputIndex: 0,
    outgoingOutputIndex: 0,
    rpcUri: 'http://localhost:7777/bob',
    secret: secretAlice,
    timeout: timeoutstamp,
    network: 'testnet',
    peerPublicKey: kpB.getPublicKeyBuffer().toString('hex'),
    bitcoinUri: 'http://admin:passwarudo@localhost:18444'
  })

  console.log(chalk.grey('creating bob'))
  const bob = new PluginBitcoin({
    incomingTxId: txAB,
    outgoingTxId: txBA,
    // TODO: maybe these are wrong sometimes
    incomingOutputIndex: 0,
    outgoingOutputIndex: 0,
    rpcUri: 'http://localhost:7777/alice',
    secret: secretBob,
    timeout: timeoutstamp,
    network: 'testnet',
    peerPublicKey: kpA.getPublicKeyBuffer().toString('hex'),
    bitcoinUri: 'http://admin:passwarudo@localhost:18444'
  })

  console.log(chalk.grey('establishing RPC'))
  establishRpc({ port: 7777, alice, bob })

  console.log(chalk.grey('connecting alice & bob'))
  await alice.connect()
  await bob.connect()

  console.log(chalk.green('done!'))
  process.exit(0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
