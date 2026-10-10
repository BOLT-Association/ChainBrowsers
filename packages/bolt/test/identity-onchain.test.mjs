// AuthBOLT holder keys on chain (docs/authbolt-onchain-holder-keys.md): registration moves the token
// from the issuer key to holder key 1 in a commit and settle the app pays for and the network has
// seen; a rotation moves it on to the next holder; a lost holder key is recovered by reissuing a token
// under the same issuer key. Runs on the pretend chain (harness.mjs), which executes every script.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import { fromBeef } from 'b017'
import { BoltHandler, brc100Core, memoryStore } from '../src/index.js'
import { IDENTITY_PROTOCOL, IdentityWallet, encodeAuthData, signDigest, verifyIdentity } from '../src/identity.js'
import { readToken } from '../src/nft.js'
import { appFunderOn, pretendChain, protoWalletOn } from './harness.mjs'

const hex = Utils.toHex
const SITE = 'peerloop.example'
const appKey = () => PrivateKey.fromRandom().toPublicKey().toString()
const challenge = (text = 'nonce') => hex(Hash.sha256(Utils.toArray(text, 'utf8')))
const SIGHASH_SINGLE_ANYONECANPAY_FORKID = 0x03 | 0x80 | 0x40

function identityOn (chain) {
  const { wallet, calls } = protoWalletOn(chain)
  const core = brc100Core({ wallet, broadcast: chain.broadcast, store: memoryStore(), protocolID: IDENTITY_PROTOCOL })
  return { ids: new IdentityWallet({ core }), core, calls }
}

const registerData = (app, count = 1, text = 'register') => encodeAuthData({ purpose: 'register', appPubKey: app, challengeHash: challenge(text), count })
const rotateData = (app, count, text = 'rotate') => encodeAuthData({ purpose: 'rotate', appPubKey: app, challengeHash: challenge(text + count), count })
const reissueData = (app, count, text = 'reissue') => encodeAuthData({ purpose: 'reissue', appPubKey: app, challengeHash: challenge(text + count), count })

async function registered (chain, { keep = true } = {}) {
  const w = identityOn(chain)
  const f = appFunderOn(chain)
  const app = appKey()
  const created = await w.ids.create()
  const data = registerData(app)
  const shown = await w.ids.present({ id: created.id, domain: SITE, appPubKey: app, data, keepSignedIn: keep, funder: f.funder })
  return { ...w, ...f, app, created, data, shown }
}

const tokenOf = (beefHex) => readToken(fromBeef(beefHex))
const sigFlag = (unlockingScript) => { const sig = unlockingScript.chunks[0].data; return sig[sig.length - 1] }

test('create: identity keys are counted (authbolt-0, authbolt-1, ...), so a seed and a count find them again', async () => {
  const chain = pretendChain()
  const { ids } = identityOn(chain)
  assert.equal((await ids.create()).keyId, 'authbolt-0')
  assert.equal((await ids.create()).keyId, 'authbolt-1')
})

test('register: the issuer key moves the token to holder 1 in a commit and settle the app pays for, both broadcast', async () => {
  const chain = pretendChain()
  const { ids, core, asked, lock, created, shown, data, app } = await registered(chain)
  const [commit, settle] = shown.package.map((b) => fromBeef(b))
  assert.ok(chain.seen.has(commit.id('hex')) && chain.seen.has(settle.id('hex')), 'the network has both')
  const holder1 = await core.publicKey('authbolt-0.holder.1')
  assert.equal(hex(readToken(settle).owner), hex(Hash.hash160(holder1)), 'the settle pays holder 1')
  assert.equal(hex(readToken(settle).issuer), created.issuer, 'the issuer, and so the identity, stays')
  assert.equal(hex(commit.inputs[0].unlockingScript.chunks[0].data), data, 'the commit carries the register data')
  assert.ok(readToken(commit.inputs[0].sourceTransaction, commit.inputs[0].sourceOutputIndex).isMint, 'the commit spends the mint')
  // The app paid: one coin of exactly what each needs, signed SINGLE | ANYONECANPAY; no change anywhere.
  assert.deepEqual(asked.map((a) => a.step), ['commit', 'settle'])
  for (const tx of [commit, settle]) {
    const funding = tx.inputs.at(-1)
    assert.equal(hex(funding.sourceTransaction.outputs[funding.sourceOutputIndex].lockingScript.toBinary()), hex(lock.toBinary()), 'funded by the app')
    assert.equal(sigFlag(funding.unlockingScript), SIGHASH_SINGLE_ANYONECANPAY_FORKID)
    assert.ok(tx.outputs.every((o) => hex(o.lockingScript.toBinary()) !== hex(lock.toBinary())), 'no change back to the app')
  }
  assert.equal(commit.outputs.length, 2, 'commit: token and proof, no change')
  assert.equal(settle.outputs.length, 1, 'settle: the token, no change')
  // The wallet's record follows the token.
  const [view] = await ids.identities()
  assert.equal(view.id, shown.id)
  assert.equal(view.holderKeyId, 'authbolt-0.holder.1')
  assert.equal(view.holderCount, 1)
  assert.equal(view.issuer, created.issuer)
  assert.ok(view.apps.some((a) => a.domain === SITE && a.appPubKey === app && a.keepSignedIn))
})

test('register: refused for another app, a count other than 1, a token that has moved, or with nobody to pay', async () => {
  const chain = pretendChain()
  const { ids, created, funder, app } = await registered(chain)
  const other = identityOn(chain)
  const fresh = await other.ids.create()
  await assert.rejects(other.ids.present({ id: fresh.id, domain: SITE, appPubKey: app, data: registerData(appKey()), funder }), /another app/)
  await assert.rejects(other.ids.present({ id: fresh.id, domain: SITE, appPubKey: app, data: registerData(app, 2), funder }), /count/)
  await assert.rejects(other.ids.present({ id: fresh.id, domain: SITE, appPubKey: app, data: registerData(app) }), /pay|fund/)
  await assert.rejects(other.ids.present({ id: fresh.id, domain: SITE, appPubKey: app, data: rotateData(app, 1), funder }), /registration/)
  const [moved] = await ids.identities()
  await assert.rejects(ids.present({ id: moved.id, domain: SITE, appPubKey: app, data: registerData(app, 1, 'again'), funder }), /moved|mint/)
  assert.ok(created) // the original mint record is gone: its id now names a spent output
})

test('verifyIdentity: a registration is a broadcast move from the mint to holder 1; the verdict names the holder and the count', async () => {
  const chain = pretendChain()
  const { shown, data, app, core, created } = await registered(chain)
  const { wallet } = protoWalletOn(chain)
  const handler = new BoltHandler({ core: brc100Core({ wallet, broadcast: chain.broadcast }) })
  const r = await verifyIdentity({ handler, package: shown.package, appPubKey: app, data })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.issuer, created.issuer)
  assert.equal(r.purpose, 'register')
  assert.equal(r.count, 1)
  assert.equal(r.holder, hex(Hash.hash160(await core.publicKey('authbolt-0.holder.1'))), 'the new holder key\'s hash')
  assert.equal(r.tokenId, shown.id)
  // An unfunded, unbroadcast move (V1's shape) carrying the same data is refused: registration is on chain.
  const other = identityOn(chain)
  const fresh = await other.ids.create()
  const unfunded = await other.ids.presentOffChain({ id: fresh.id, appPubKey: app, data })
  const off = await verifyIdentity({ handler, package: unfunded, appPubKey: app, data })
  assert.equal(off.ok, false)
  assert.match(off.reason, /broadcast|on chain/)
})

test('sign: after registering, sign-in and writes are signed by holder 1, not the issuer key', async () => {
  const chain = pretendChain()
  const { ids, app, core, created } = await registered(chain)
  const s = await ids.sign({ domain: SITE, appPubKey: app, kind: 'signin', payload: '02aa', silent: true })
  assert.equal(s.identity, created.issuer)
  assert.equal(s.holder, hex(await core.publicKey('authbolt-0.holder.1')))
  assert.notEqual(s.holder, created.issuer)
  const sig = s.signature
  assert.ok(typeof sig === 'string' && sig.length > 16)
  assert.ok(signDigest({ kind: 'signin', appPubKey: app, payload: '02aa' }).length === 32)
})

test('rotate: the app\'s request moves the token to the next holder on chain, silently under the grant, twice', async () => {
  const chain = pretendChain()
  const { ids, app, core, funder, created } = await registered(chain)
  for (const n of [2, 3]) {
    const r = await ids.rotate({ domain: SITE, appPubKey: app, data: rotateData(app, n), funder, silent: true })
    const [commit, settle] = r.package.map((b) => fromBeef(b))
    assert.ok(chain.seen.has(commit.id('hex')) && chain.seen.has(settle.id('hex')))
    assert.equal(hex(readToken(settle).owner), hex(Hash.hash160(await core.publicKey(`authbolt-0.holder.${n}`))))
    assert.equal(hex(readToken(settle).issuer), created.issuer)
    const [view] = await ids.identities()
    assert.equal(view.holderCount, n)
    assert.equal(view.holderKeyId, `authbolt-0.holder.${n}`)
    const s = await ids.sign({ domain: SITE, appPubKey: app, kind: 'refresh', payload: '03bb', silent: true })
    assert.equal(s.holder, hex(await core.publicKey(`authbolt-0.holder.${n}`)), 'the new holder signs from now on')
  }
  await assert.rejects(ids.rotate({ domain: SITE, appPubKey: app, data: rotateData(app, 5), funder, silent: true }), /count/, 'a skipped count')
  await assert.rejects(ids.rotate({ domain: SITE, appPubKey: app, data: registerData(app, 4), funder, silent: true }), /rotate/)
})

test('rotate: never silently without the keep-signed-in grant', async () => {
  const chain = pretendChain()
  const { ids, app, funder } = await registered(chain, { keep: false })
  await assert.rejects(ids.rotate({ domain: SITE, appPubKey: app, data: rotateData(app, 2), funder, silent: true }), (e) => e.code === 'NEEDS_PROMPT')
  const [view] = await ids.identities()
  const r = await ids.rotate({ id: view.id, domain: SITE, appPubKey: app, data: rotateData(app, 2), funder, silent: false })
  assert.equal(r.package.length, 2)
})

test('reissue: a lost holder key - the same issuer key mints a new token and moves it to the next holder; the old one is dead', async () => {
  const chain = pretendChain()
  const { ids, app, core, funder, created, data } = await registered(chain)
  const [before] = await ids.identities()
  await assert.rejects(ids.reissue({ id: before.id, domain: SITE, appPubKey: app, data: reissueData(app, 2), funder, silent: true }), (e) => e.code === 'NEEDS_PROMPT', 'never silent')
  const r = await ids.reissue({ id: before.id, domain: SITE, appPubKey: app, data: reissueData(app, 2), funder, silent: false })
  const [commit, settle] = r.package.map((b) => fromBeef(b))
  const mint = commit.inputs[0].sourceTransaction
  assert.ok(readToken(mint, commit.inputs[0].sourceOutputIndex).isMint, 'a new mint')
  assert.equal(hex(readToken(mint).issuer), created.issuer, 'under the same issuer key: the same identity')
  assert.ok(chain.seen.has(mint.id('hex')) && chain.seen.has(commit.id('hex')) && chain.seen.has(settle.id('hex')))
  assert.equal(hex(readToken(settle).owner), hex(Hash.hash160(await core.publicKey('authbolt-0.holder.2'))))
  const views = await ids.identities()
  assert.equal(views.length, 1, 'the dead token is no longer offered')
  assert.equal(views[0].id, r.id)
  assert.equal(views[0].holderCount, 2)
  assert.ok(views[0].apps.some((a) => a.domain === SITE && a.appPubKey === app), 'the app link carries over')
  // The verifier takes a reissue like a registration: a new mint, moved on chain, the count continues.
  const { wallet } = protoWalletOn(chain)
  const handler = new BoltHandler({ core: brc100Core({ wallet, broadcast: chain.broadcast }) })
  const v = await verifyIdentity({ handler, package: r.package, appPubKey: app, data: reissueData(app, 2) })
  assert.equal(v.ok, true, v.reason)
  assert.equal(v.purpose, 'reissue')
  assert.equal(v.count, 2)
  assert.ok(data)
})

test('answer: signin, refresh and write sign; rotate and reissue move the token; the off-chain kinds are gone', async () => {
  const chain = pretendChain()
  const { ids, app, funder } = await registered(chain)
  assert.ok((await ids.answer({ domain: SITE, appPubKey: app, kind: 'signin', payload: '02aa', silent: true })).signature)
  const r = await ids.answer({ domain: SITE, appPubKey: app, kind: 'rotate', payload: rotateData(app, 2), funder, silent: true })
  assert.equal(r.package.length, 2)
  for (const kind of ['confirm', 'recover']) {
    await assert.rejects(ids.answer({ domain: SITE, appPubKey: app, kind, payload: '', silent: true }), /unknown kind/)
  }
  for (const gone of ['rotateHolder', 'recoverHolder', 'confirmHolder', 'refresh']) assert.equal(typeof ids[gone], 'undefined', gone)
})
