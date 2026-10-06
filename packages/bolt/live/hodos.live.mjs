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
import { walletBroadcaster, walletStore } from '../src/wallet-rail.js'

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

/** A wallet whose keys are the SDK's ProtoWallet. `funded` adds a funding rail: Hodos pays the P2PKH
 *  output this wallet asks for (to this wallet's own key), so this wallet's key signs what spends it. */
const keyOnly = ({ funded = false } = {}) => {
  const proto = new ProtoWallet(PrivateKey.fromRandom())
  return {
    getPublicKey: (a) => proto.getPublicKey(a),
    createSignature: (a) => proto.createSignature(a),
    getHeaderForHeight: (a) => hodos.getHeaderForHeight(a),
    ...(funded ? { createAction: (a) => hodos.createAction(a) } : {})
  }
}

// The issuer works the way a page in Hodos does: the network and the token store are the wallet's
// (POST /boltBroadcast, POST /boltTokens), not Arcade and local memory.
const rail = (endpoint, body) => hodos[endpoint.slice(1)](body)
const issuer = new BoltHandler({ core: brc100Core({ wallet: hodos, broadcast: walletBroadcaster(rail), store: walletStore(rail) }) })
const issuerKey = (await issuer.getKey()).publicKey
step(`issuer key from Hodos ${issuerKey.slice(0, 16)}â€¦`)
// The user keeps tokens in a real on-disk SQLite store (a file), so persistence is exercised against
// live Arcade BEEFs, not only the headless pretend chain.
const userDb = join(mkdtempSync(join(tmpdir(), 'bolt-live-')), 'tokens.db')
const userStore = nodeSqliteStore(userDb)
const user = new BoltHandler({ core: brc100Core({ wallet: keyOnly({ funded: true }), arcadeUrl: ARCADE, store: userStore }), trustedIssuers: [issuerKey] })
const site = new BoltHandler({ core: brc100Core({ wallet: keyOnly(), arcadeUrl: ARCADE }), trustedIssuers: [issuerKey] })

const minted = await issuer.mint({ type: 'AuthBOLT' })
step(`Hodos minted AuthBOLT ${minted.id.slice(0, 16)}â€¦ (funded by createAction, signed by createSignature, on the network)`)

const { package: pkg } = await issuer.transfer(minted.id, (await user.getKey()).pubKeyHash)
step(`Hodos transferred it: commit and settle on the network (${Math.round(pkg.join('').length / 2)} bytes of BEEF)`)

const got = await user.receive(pkg)
assert.equal(got.ok, true, got.reason)
step(`the user verified and kept ${got.tokenId.slice(0, 16)}â€¦`)

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
step(`a foreign issuer is refused (${wrong.reason.slice(0, 40)}â€¦)`)

// --- fungible (SimpleMultiBOLT): mint with an amount, transfer the whole token, receive ---
const fmint = await issuer.mint({ type: 'SimpleMultiBOLT', amount: '1000000' })
step(`Hodos minted SimpleMultiBOLT ${fmint.id.slice(0, 16)}â€¦ amount 1000000 (on the network)`)
assert.equal(await issuer.balance(issuerKey), '1000000')
const fpkg = (await issuer.transfer(fmint.id, (await user.getKey()).publicKey)).package
step(`Hodos transferred the fungible token (${Math.round(fpkg.join('').length / 2)} bytes of BEEF)`)
const fgot = await user.receive(fpkg)
assert.equal(fgot.ok, true, fgot.reason)
assert.equal(fgot.type, 'SimpleMultiBOLT')
assert.equal(await issuer.balance(issuerKey), '0')
assert.equal(await user.balance(issuerKey), '1000000')
step(`the user received it; balances moved (issuer 0, user ${await user.balance(issuerKey)})`)

// --- partial payment by split: mint 1000, pay the user 250, keep the remainder ---
await issuer.mint({ type: 'SimpleMultiBOLT', amount: '1000' })
const userBefore = BigInt(await user.balance(issuerKey))
const ppkg = (await issuer.pay(issuerKey, '250', (await user.getKey()).publicKey)).package
const pgot = await user.receive(ppkg)
assert.equal(pgot.ok, true, pgot.reason)
assert.equal(pgot.kind, 'split')
assert.equal(await issuer.balance(issuerKey), '750')
assert.equal(BigInt(await user.balance(issuerKey)), userBefore + 250n)
step(`Hodos paid the user 250 by split (self-transfer + split, on the network); issuer keeps 750`)

// --- the user re-spends the split piece it received (no change of its own: one wallet funding) ---
const sitePub = (await site.getKey()).publicKey
const rgot = await site.receive((await user.pay(issuerKey, '100', sitePub)).package)
assert.equal(rgot.ok, true, rgot.reason)
assert.equal(rgot.kind, 'split')
assert.equal(await site.balance(issuerKey), '100')
assert.equal(BigInt(await user.balance(issuerKey)), userBefore + 150n)
step('the user re-spent the received split piece: paid the site 100, keeps 150 of it (on the network)')

// --- pay across tokens: no single token covers the amount, so the user's tokens are merged ---
const all = BigInt(await user.balance(issuerKey))
const largest = (await user.list()).reduce((m, r) => (BigInt(r.amount ?? 0) > m ? BigInt(r.amount) : m), 0n)
assert.ok(largest < all - 50n, 'the amount below needs more than the largest single token')
const mgot = await site.receive((await user.pay(issuerKey, (all - 50n).toString(), sitePub)).package)
assert.equal(mgot.ok, true, mgot.reason)
assert.equal(await user.balance(issuerKey), '50')
assert.equal(BigInt(await site.balance(issuerKey)), all - 50n + 100n)
step(`the user paid ${all - 50n} across tokens (merge + split, on the network); keeps 50`)

// --- melt: the user destroys what is left ---
const last = (await user.list()).find((r) => r.type === 'SimpleMultiBOLT')
const melted = await user.melt(last.id)
assert.equal(await user.balance(issuerKey), '0')
step(`the user melted the remaining 50 (${melted.txid.slice(0, 16)}… on the network)`)

// The wallet's own table holds what the issuer did: retired rows are kept with their BEEFs.
const kept = await hodos.boltTokens({ op: 'list', status: 'spent' })
const heldNow = await hodos.boltTokens({ op: 'list' })
assert.ok(kept.rows.length >= 3 && kept.rows.every((r) => r.status === 'spent' && /^[0-9a-f]+$/.test(r.beef)))
assert.equal(heldNow.rows.filter((r) => r.type === 'SimpleMultiBOLT').map((r) => r.amount).join(','), '750')
step(`the wallet's bolt_tokens table: ${heldNow.rows.length} held, ${kept.rows.length} spent rows kept`)

console.log('wallet methods used:', [...calls].sort().join(', '))
console.log('PASS BOLT handler on Hodos + Arcade')
