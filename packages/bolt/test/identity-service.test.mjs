// The browser's trusted side (Hodos's identity prompt): IdentityWallet over the wallet's HTTP rails,
// called as the wallet itself. Here the rails are served by a fake wallet on the pretend chain.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PrivateKey, ProtoWallet, Script, Transaction } from '@bsv/sdk'
import { BoltHandler, brc100Core, encodeAuthData, verifyIdentity } from '../src/index.js'
import { identityService } from '../src/identity-service.js'
import { appFunderOn, pretendChain } from './harness.mjs'

const json = (x) => JSON.parse(JSON.stringify(x))

function walletRails (chain) {
  const proto = new ProtoWallet(PrivateKey.fromRandom())
  const rows = new Map()
  const asked = []
  const endpoints = {
    '/getPublicKey': (a) => proto.getPublicKey(a),
    '/createSignature': (a) => proto.createSignature(a),
    '/getHeaderForHeight': async ({ height }) => ({ header: chain.headers.get(height) }),
    '/createAction': async ({ outputs }) => {
      const tx = chain.mine(Script.fromHex(outputs[0].lockingScript), outputs[0].satoshis)
      return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
    },
    '/boltBroadcast': async ({ tx: hex }) => {
      let tx
      try { tx = Transaction.fromHexEF(hex) } catch { tx = Transaction.fromHex(hex) }
      for (const i of tx.inputs) i.sourceTransaction = chain.txs.get(i.sourceTXID)
      return chain.broadcast(tx)
    },
    '/boltTokens': async ({ op, row, outpoint, wallet }) => {
      if (op === 'put') { if (!rows.has(row.outpoint)) rows.set(row.outpoint, { ...row, status: 'held' }); return { ok: true } }
      if (op === 'get') return { row: rows.get(outpoint) ?? null }
      if (op === 'list') return { rows: [...rows.values()].filter((r) => r.status === 'held') }
      if (op === 'spend') { const r = rows.get(outpoint); if (r) r.status = 'spent'; return { ok: true } }
      if (op === 'annotate') { const r = rows.get(outpoint); if (r) r.attributes = JSON.stringify({ ...JSON.parse(r.attributes), wallet }); return { ok: true } }
      return { error: `unknown op ${op}` }
    }
  }
  const call = async (endpoint, body) => {
    asked.push(endpoint)
    const reply = json(await endpoints[endpoint](json(body ?? {})))
    if (reply?.error) throw new Error(reply.error)
    return reply
  }
  return { call, rows, asked }
}

test('identityService: creates, links and presents an identity through the wallet rails only', async () => {
  const chain = pretendChain()
  const rails = walletRails(chain)
  const ids = identityService(rails.call)
  const app = PrivateKey.fromRandom().toPublicKey().toString()
  const created = await ids.create()
  const data = encodeAuthData({ purpose: 'register', appPubKey: app, challengeHash: 'cd'.repeat(32), count: 1 })
  const { funder } = appFunderOn(chain)
  const { package: pkg, id: movedId } = await ids.present({ id: created.id, domain: 'peerloop.example', appPubKey: app, data, keepSignedIn: true, funder })

  const site = new BoltHandler({ core: brc100Core({ wallet: { getHeaderForHeight: async ({ height }) => ({ header: chain.headers.get(height) }) }, broadcast: chain.broadcast }) })
  const r = await verifyIdentity({ handler: site, package: pkg, appPubKey: app, data })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.issuer, created.issuer)

  // The link and the keep-signed-in choice live in the wallet's own table, under attributes.wallet.
  const stored = JSON.parse(rails.rows.get(movedId).attributes).wallet
  assert.equal(stored.holderCount, 1, 'the token moved to holder 1 at registration')
  assert.deepEqual(stored.apps.map((a) => [a.domain, a.appPubKey, a.keepSignedIn]), [['peerloop.example', app, true]])
  assert.deepEqual([...new Set(rails.asked)].sort(), ['/boltBroadcast', '/boltTokens', '/createAction', '/createSignature', '/getPublicKey'])
  // Keys are asked under the identity protocol, never the page's BOLT protocol.
  assert.equal((await ids.forApp({ domain: 'peerloop.example', appPubKey: app })).length, 1)
})
