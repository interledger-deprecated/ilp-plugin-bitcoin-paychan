# ilp-plugin-bitcoin-paychan
> Interledger.js Ledger Plugin for Bitcoin using CLTV Payment Channels

<a href="https://bitcoin.org"><img src="./images/bitcoin.png" alt="Bitcoin" height="50px" /></a><img height="45" hspace="5" /><img src="./images/plus.png" height="45" /><img height="45" hspace="5" /><a href="https://interledger.org"><img src="./images/interledgerjs.png" alt="Interledger.js" height="50px" /></a>


This plugin enables [Interledger](https://interledger.org) payments through [Bitcoin](https://bitcoin.org) using simple payment channels.

`ilp-plugin-bitcoin-paychan` implements the [Interledger.js Ledger Plugin Interface](https://github.com/interledger/rfcs/blob/master/0004-ledger-plugin-interface/0004-ledger-plugin-interface.md), which allows Bitcoin to be used with [`ilp` client](https://github.com/interledgerjs/ilp) and the [`ilp-connector`](https://github.com/interledgerjs/ilp-connector).

## Installation

**Dependencies:**

- Node.js >=v7.10.0
- Bitcoin Cored Node

**Setup:**

```sh
git clone https://github.com/interledgerjs/ilp-plugin-bitcoin-paychan.git
cd ilp-plugin-bitcoin-paychan
npm install
```


## How It Works

`ilp-plugin-bitcoin-paychan` uses simple unidirectional Bitcoin payment channels implemented with [CHECKLOCKTIMEVERIFY (CLTV)](https://github.com/bitcoin/bips/blob/master/bip-0065.mediawiki). While the underlying channel is not conditional (i.e. does not use hashlocks), the plugin only sends updates to the channel when it receives the fulfillment from the other party. This means that payments that there is some risk for payments that are in flight. However, the Interledger Protocol isolates participants from risk from indirect peers.

By implementing all of the functions required by the [Ledger Plugin Interface](https://github.com/interledger/rfcs/blob/master/0004-ledger-plugin-interface/0004-ledger-plugin-interface.md), this allows Bitcoin to be used by standard Interledger.js components.

For more information about how Interledger works, see [IL-RFC 1: Interledger Architecture](https://github.com/interledger/rfcs/blob/master/0001-interledger-architecture/0001-interledger-architecture.md).

