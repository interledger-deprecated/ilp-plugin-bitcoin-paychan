'use strict'
const PluginBitcoin = require('.')
const uuid = require('uuid')
const crypto = require('crypto')
const bitcoin = require('./src/bitcoin')
const ObjectStore = require('ilp-plugin-shared').ObjStore
const btc = require('bitcoinjs-lib')
const child = require('child_process')
const Koa = require('koa')
const Router = require('koa-router')
const Parser = require('koa-bodyparser')
const chalk = require('chalk')
const BTC_SCALE = 1e8
const USER = process.env.BTC_USER
const PASS = process.env.BTC_PASS

if (!USER || !PASS) {
  throw new Error('set env variables BTC_USER and BTC_PASS to connect to RPC')
}

process.on('unhandledRejection', e => console.error(e));

const base64url = function (buf) {
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

const makeRpcCallback = function (plugin) {
  return async function (ctx) {
    const { method, prefix } = ctx.query

    try {
      const res = await plugin.receive(method, ctx.request.body)
      ctx.body = res
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
      if (stderr) console.error(stderr)
      if (err) reject(err)
      console.log('"' + command + '" -> "' + stdout.trim() + '"')
      resolve(stdout.trim())
    })
  })
}

async function run () {
  const timeoutstamp = Math.floor(Date.now() / 1000)

  console.log(chalk.grey('set timeout to ' + timeoutstamp))
  console.log(chalk.grey('generating channel addresses'))
  const secretAlice = '3b6386909838945a840b26c10fc794b1a536ea1ab02c162ecb62d565e24ed94a'
  const secretBob = '80044da2f41364353b173aacc42b8694125cda4636a979105c400e4d6bf4684f'
  const kpA = bitcoin.secretToKeypair(secretAlice)
  const kpB = bitcoin.secretToKeypair(secretBob)

  console.log('public key alice:', kpA.getPublicKeyBuffer().toString('hex'))
  console.log('public key bob:', kpB.getPublicKeyBuffer().toString('hex'))
  /*
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
  */

  console.log(chalk.grey('creating alice'))
  const alice = new PluginBitcoin({
    _store: new ObjectStore(),
    outgoingAmount: 1 * BTC_SCALE,
    /*incomingTxId: txBA,
    outgoingTxId: txAB,
    // TODO: maybe these are wrong sometimes
    incomingOutputIndex: 0,
    outgoingOutputIndex: 0,*/
    maxInFlight: 0.5 * BTC_SCALE, 
    rpcUri: 'http://localhost:7777/bob',
    secret: secretAlice,
    timeout: timeoutstamp,
    network: 'testnet',
    peerPublicKey: kpB.getPublicKeyBuffer().toString('hex'),
    bitcoinUri: 'http://' + USER + ':' + PASS + '@localhost:18444'
  })

  console.log(chalk.grey('creating bob'))
  const bob = new PluginBitcoin({
    _store: new ObjectStore(),
    outgoingAmount: 1 * BTC_SCALE,
    /*incomingTxId: txAB,
    outgoingTxId: txBA,
    // TODO: maybe these are wrong sometimes
    incomingOutputIndex: 0,
    outgoingOutputIndex: 0,*/
    maxInFlight: 0.5 * BTC_SCALE, 
    rpcUri: 'http://localhost:7777/alice',
    secret: secretBob,
    timeout: timeoutstamp,
    network: 'testnet',
    peerPublicKey: kpA.getPublicKeyBuffer().toString('hex'),
    bitcoinUri: 'http://' + USER + ':' + PASS + '@localhost:18444'
  })

  console.log(chalk.grey('establishing RPC'))
  establishRpc({ port: 7777, alice, bob })

  console.log(chalk.grey('connecting alice & bob'))
  await Promise.all([
    alice.connect(),
    bob.connect() 
  ])

  console.log(chalk.yellow('fetching plugin metadata'))
  console.log(chalk.green('alice account:'), alice.getAccount())
  console.log(chalk.green('bob info:'), bob.getInfo())

  console.log(chalk.yellow('sending a message alice -> bob'))
  bob.once('incoming_message', (msg) => {
    console.log(chalk.green('bob got message:'), msg)
  })
  await alice.sendMessage({
    to: bob.getAccount(),
    data: { foo: 'bar' }
  })

  console.log(chalk.yellow('sending a message bob -> alice'))
  alice.once('incoming_message', (msg) => {
    console.log(chalk.green('alice got message:'), msg)
  })
  await bob.sendMessage({
    to: alice.getAccount(),
    data: { bar: 'foo' }
  })

  console.log(chalk.grey('and now, the moment you\'ve all been waiting for'))
  console.log(chalk.yellow('sending a transfer'))

  const fulfillment = crypto.randomBytes(32)
  const condition = crypto.createHash('sha256').update(fulfillment).digest()
  console.log(chalk.grey('fulfillment:'), base64url(fulfillment))
  console.log(chalk.grey('condition:  '), base64url(condition))

  bob.once('incoming_prepare', (transfer) => {
    console.log(chalk.green('bob got transfer:'), transfer)
    console.log(chalk.yellow('fulfilling a transfer'))
    console.log(chalk.grey('calling bob.fulfillCondition'))
    bob.fulfillCondition(transfer.id, base64url(fulfillment))
  })

  console.log(chalk.grey('calling alice.sendTransfer'))
  await alice.sendTransfer({
    id: uuid(),
    to: bob.getAccount(),
    amount: 0.1 * BTC_SCALE,
    ilp: 'thequickbrownfoxjumpsoverthelazydog',
    executionCondition: base64url(condition),
    expiresAt: new Date(Date.now() + 1000).toISOString()
  })

  await new Promise((resolve) => setTimeout(resolve, 5000))
  await bob.disconnect()

  console.log(chalk.green('done!'))
  //process.exit(0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
