// The in-page shim: run the real bundled IIFE (dist/bolt-shim.js) inside fake pages (node:vm) whose
// wallet bridge is backed by a fake wallet: real BRC-100 keys (the SDK's ProtoWallet), the pretend
// chain behind POST /boltBroadcast, and a token table behind POST /boltTokens that follows the rules
// of the wallet's own (Hodos `bolt_token_repo.rs`: token data written once, spent rows kept).
//
// It proves the shim's wiring end to end: everything the page does leaves through the bridge, tokens
// live in the wallet (a reloaded page still has them), and a token moves between two wallets.
//
// Run `npm run bundle` first (the tests skip with a clear message if the bundle is absent).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { Hash, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk'
import { PAGE_METHODS } from '../src/index.js'
import { pretendChain } from './harness.mjs'

const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bolt-shim.js')
const skip = !existsSync(bundlePath) && 'run `npm run bundle` first'
const bundle = skip ? '' : readFileSync(bundlePath, 'utf8')
const json = (x) => JSON.parse(JSON.stringify(x)) // what crosses the real bridge is JSON

/** A wallet as the page's bridge sees it. `seen` logs every (method, endpoint). */
function fakeWallet (chain) {
  const proto = new ProtoWallet(PrivateKey.fromRandom())
  const table = new Map() // outpoint -> row
  const seen = []
  let clock = 1000
  const tokens = ({ op, row, outpoint, status = 'held', issuer, type }) => {
    if (op === 'put') {
      const had = table.get(row.outpoint)
      if (had) {
        Object.assign(had, {
          anchor_network: row.anchor_network, anchor_proven: row.anchor_proven, anchor_height: row.anchor_height,
          anchor_merkle_root: row.anchor_merkle_root, provenance: row.provenance ?? had.provenance, updated_at: ++clock
        })
      } else {
        const now = ++clock
        table.set(row.outpoint, { ...row, status: 'held', created_at: now, updated_at: now })
      }
      return { ok: true }
    }
    if (op === 'get') return { row: table.get(outpoint) ?? null }
    if (op === 'list') {
      return { rows: [...table.values()].filter((r) => r.status === status && (!issuer || r.issuer === issuer) && (!type || r.type === type)) }
    }
    if (op === 'spend') {
      const r = table.get(outpoint)
      const spent = !!r && r.status === 'held'
      if (spent) { r.status = 'spent'; r.updated_at = ++clock }
      return { ok: true, spent }
    }
    return { error: `unknown op ${op}` }
  }
  const broadcast = async ({ tx: hex }) => {
    let tx
    try { tx = Transaction.fromHexEF(hex) } catch { tx = Transaction.fromHex(hex) }
    for (const input of tx.inputs) input.sourceTransaction = chain.txs.get(input.sourceTXID) // the node knows its UTXOs
    const { status, detail } = await chain.broadcast(tx)
    return { status, detail: detail ?? status }
  }
  const endpoints = {
    getPublicKey: (a) => proto.getPublicKey(a),
    createSignature: (a) => proto.createSignature(a),
    getHeaderForHeight: async ({ height }) => ({ header: chain.headers.get(height) }),
    createAction: async ({ outputs }) => {
      const tx = chain.mine(Script.fromHex(outputs[0].lockingScript), outputs[0].satoshis)
      return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
    },
    boltBroadcast: broadcast,
    boltTokens: async (a) => tokens(a)
  }
  const walletCall = async (method, endpoint, args) => {
    seen.push([method, endpoint])
    if (!endpoints[method]) return { error: `no such endpoint ${endpoint}` }
    return json(await endpoints[method](json(args ?? {})))
  }
  return { walletCall, table, seen }
}

/** A page: a fresh JS realm that loads the bundle and installs BOLT over `wallet`'s bridge. */
function page (wallet, { trustedIssuers = [] } = {}) {
  const sandbox = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(bundle, sandbox)
  sandbox.BoltShim.installBolt({ walletCall: wallet.walletCall, trustedIssuers, target: sandbox })
  return sandbox.BOLT
}

test('the bundle installs a frozen window.BOLT with exactly the page methods', { skip }, () => {
  const sandbox = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(bundle, sandbox)
  sandbox.BoltShim.installBolt({ walletCall: async () => ({}), target: sandbox })
  assert.deepEqual(Object.keys(sandbox.BOLT).sort(), Object.keys(PAGE_METHODS).sort())
  assert.throws(() => { sandbox.BOLT = 1 }, 'BOLT is non-writable')
  assert.ok(Object.isFrozen(sandbox.BOLT))
})

test('getKey() rides the bridge to the BRC-100 endpoint; a wallet error is thrown', { skip }, async () => {
  const wallet = fakeWallet(pretendChain())
  const key = await page(wallet).getKey()
  assert.match(key.publicKey, /^0[23][0-9a-f]{64}$/)
  assert.equal(key.pubKeyHash, Utils.toHex(Hash.hash160(Utils.toArray(key.publicKey, 'hex'))))
  assert.deepEqual(wallet.seen, [['getPublicKey', '/getPublicKey']])

  const refusing = { walletCall: async () => ({ error: 'user declined' }) }
  await assert.rejects(page(refusing).getKey(), /getPublicKey: user declined/)
})

test('mint, pay and receive between two wallets, all through the bridge', { skip }, async () => {
  const chain = pretendChain()
  const issuerWallet = fakeWallet(chain)
  const userWallet = fakeWallet(chain)
  const issuer = page(issuerWallet)
  const issuerKey = (await issuer.getKey()).publicKey
  const user = page(userWallet, { trustedIssuers: [issuerKey] })

  await issuer.mint({ type: 'SimpleMultiBOLT', amount: '1000' })
  const { package: pkg } = await issuer.pay(issuerKey, '300', (await user.getKey()).publicKey)
  const got = await user.receive(pkg)
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.kind, 'split')
  assert.equal('txs' in got, false) // plain data only

  const held = (b) => b.list().then((rows) => rows.map((r) => r.amount).join(','))
  assert.equal(await held(user), '300')
  assert.equal(await held(issuer), '700')

  // nothing reached the network except through the wallet, and nothing but the wallet rails was used
  const used = new Set(issuerWallet.seen.concat(userWallet.seen).map(([m]) => m))
  const rails = ['boltBroadcast', 'boltTokens', 'createAction', 'createSignature', 'getHeaderForHeight', 'getPublicKey']
  assert.deepEqual([...used].filter((m) => !rails.includes(m)), [])
  assert.ok(used.has('boltBroadcast') && used.has('boltTokens'))
  assert.ok(chain.sent.length >= 5, 'mint, self-transfer and split were broadcast through /boltBroadcast')

  // the wallet kept the spent rows (mint, self-settle) and their BEEFs; only the remainder is held
  const rows = [...issuerWallet.table.values()]
  assert.deepEqual(rows.map((r) => r.status).sort(), ['held', 'spent', 'spent'])
  assert.ok(rows.every((r) => /^[0-9a-f]+$/.test(r.beef)))
})

test('tokens live in the wallet: a reloaded page (a new realm) still holds and can spend them', { skip }, async () => {
  const chain = pretendChain()
  const issuerWallet = fakeWallet(chain)
  const first = page(issuerWallet)
  const issuerKey = (await first.getKey()).publicKey
  const { id } = await first.mint({ type: 'AuthBOLT' })

  const reloaded = page(issuerWallet) // same wallet, new page: nothing carried over in page memory
  const rows = await reloaded.list()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, id)
  assert.equal(rows[0].issuer, issuerKey)

  // and it can still present the token it did not mint in this realm
  const site = page(fakeWallet(chain))
  const shown = await site.verify((await reloaded.present(id, { data: 'c0ffee' })).package, { issuer: issuerKey })
  assert.equal(shown.ok, true, shown.reason)
  assert.equal(shown.kind, 'presentation')
  assert.equal(shown.data, 'c0ffee')
})
