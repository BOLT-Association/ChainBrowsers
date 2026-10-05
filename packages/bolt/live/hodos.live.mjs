// Live: the handler on a real Hodos wallet (its BRC-100 HTTP interface, untouched) and Arcade.
//
//   issuer  = the Hodos wallet (spv mode, funded: tests/hodos-spv/fund.mjs)
//   user, site = keys held by the SDK's ProtoWallet, reading headers through the same Hodos wallet
//
// Hodos mints an AuthBOLT, transfers it to the user; the user presents it to the site with a challenge.
// Every token transaction goes to Arcade and must get a network status.
//
//   node live/hodos.live.mjs        (stack up, wallet on :31401; see docs/hodos-spv.md)
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hash, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { BoltHandler, brc100Core, nodeSqliteStore } from '../src/index.js'

const WALLET = process.env.WALLET_URL ?? 'http://127.0.0.1:31401'
const ARCADE = process.env.ARCADE_URL ?? 'http://localhost:8080'
const step = (m) => console.log('ok  ', m)

const calls = new Set()
/** A BRC-100 client over the wallet's HTTP interface. Hodos reports errors as 200 with an `error` body. */
const hodos = new Proxy({}, {
  get: (_, method) => async (args = {}) => {
    calls.add(method)
    const res = await fetch(`${WALLET}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })
    const text = await res.text()
    let json; try { json = JSON.parse(text) } catch { throw new Error(`${method}: ${res.status} ${text.slice(0, 200)}`) }
    if (!res.ok || json.error) throw new Error(`${method}: ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
    return json
  }
})

const keyOnly = () => {
  const proto = new ProtoWallet(PrivateKey.fromRandom())
  return {
    getPublicKey: (a) => proto.getPublicKey(a),
    createSignature: (a) => proto.createSignature(a),
    getHeaderForHeight: (a) => hodos.getHeaderForHeight(a)
  }
}

const issuer = new BoltHandler({ core: brc100Core({ wallet: hodos, arcadeUrl: ARCADE }) })
const issuerKey = (await issuer.getKey()).publicKey
step(`issuer key from Hodos ${issuerKey.slice(0, 16)}…`)
// The user keeps tokens in a real on-disk SQLite store (a file), so persistence is exercised against
// live Arcade BEEFs, not only the headless pretend chain.
const userDb = join(mkdtempSync(join(tmpdir(), 'bolt-live-')), 'tokens.db')
const userStore = nodeSqliteStore(userDb)
const user = new BoltHandler({ core: brc100Core({ wallet: keyOnly(), arcadeUrl: ARCADE, store: userStore }), trustedIssuers: [issuerKey] })
const site = new BoltHandler({ core: brc100Core({ wallet: keyOnly(), arcadeUrl: ARCADE }), trustedIssuers: [issuerKey] })

const minted = await issuer.mint({ type: 'AuthBOLT' })
step(`Hodos minted AuthBOLT ${minted.id.slice(0, 16)}… (funded by createAction, signed by createSignature, on the network)`)

const { package: pkg } = await issuer.transfer(minted.id, (await user.getKey()).pubKeyHash)
step(`Hodos transferred it: commit and settle on the network (${Math.round(pkg.join('').length / 2)} bytes of BEEF)`)

const got = await user.receive(pkg)
assert.equal(got.ok, true, got.reason)
step(`the user verified and kept ${got.tokenId.slice(0, 16)}…`)

// Everything we know about the anchor was stored, with a real network status from Arcade.
const rec = await userStore.get(got.tokenId)
assert.equal(rec.anchor.kind, 'settle')
assert.ok(['accepted', 'already-seen'].includes(rec.anchor.network), rec.anchor.network)
assert.equal(rec.provenance.kind, 'mint')
step(`anchor stored: kind=${rec.anchor.kind} network=${rec.anchor.network} proven=${rec.anchor.proven} provenance=${rec.provenance.kind}`)

// A second connection to the same SQLite file sees the committed token (the live store stays open for
// the presentation below).
const reopened = nodeSqliteStore(userDb)
const back = await reopened.get(got.tokenId)
assert.ok(back && back.type === 'AuthBOLT' && back.issuer === issuerKey, 'token readable from a second connection')
reopened.close()
step('token persisted to SQLite (read back on a fresh connection)')

const challenge = Utils.toHex(Hash.sha256(Utils.toArray(`login ${Date.now()}`, 'utf8')))
const shown = await site.verify((await user.present(got.tokenId, { data: challenge })).package)
assert.equal(shown.ok, true, shown.reason)
assert.equal(shown.kind, 'presentation')
assert.equal(shown.data, challenge)
assert.equal(shown.issuer, issuerKey)
step('the site verified an unfunded presentation carrying its 32-byte challenge')

const wrong = await site.verify(pkg, { issuer: '02' + '11'.repeat(32) })
assert.equal(wrong.ok, false)
step(`a foreign issuer is refused (${wrong.reason.slice(0, 40)}…)`)

console.log('wallet methods used:', [...calls].sort().join(', '))
console.log('PASS BOLT handler on Hodos + Arcade')
