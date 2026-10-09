// AuthBOLT identities: a token per identity, its own key, tagged for the apps it was shown to, and
// presented only with data that names the app asking. Runs on the pretend chain (harness.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BigNumber, ECDSA, Hash, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk'
import { existsSync, readFileSync } from 'node:fs'
import { fromBeef } from 'b017'
import { BoltHandler, brc100Core, memoryStore } from '../src/index.js'
import {
  AUTH_DATA_BYTES, IDENTITY_PROTOCOL, IdentityWallet, decodeAuthData, encodeAuthData, signDigest, verifyIdentity
} from '../src/identity.js'
import { WRITE_TIERS } from '../src/write-tiers.js'
import { pretendChain, protoWalletOn } from './harness.mjs'

const hex = Utils.toHex
const appKey = () => PrivateKey.fromRandom().toPublicKey().toString()
const challenge = (text = 'nonce') => hex(Hash.sha256(Utils.toArray(text, 'utf8')))
const SITE = 'peerloop.example'

function identityOn (chain, store = memoryStore()) {
  const { wallet, calls } = protoWalletOn(chain)
  const core = brc100Core({ wallet, broadcast: chain.broadcast, store, protocolID: IDENTITY_PROTOCOL })
  return { ids: new IdentityWallet({ core }), store, calls, wallet }
}

/** A relying party: it trusts whatever issuer the package names (users are the issuers). */
function verifierOn (chain) {
  const { wallet } = protoWalletOn(chain)
  return new BoltHandler({ core: brc100Core({ wallet, broadcast: chain.broadcast }) })
}

test('auth data: tag, app key and challenge hash, 66 bytes, and nothing else reads as one', () => {
  const app = appKey()
  const data = encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge() })
  assert.equal(data.length, AUTH_DATA_BYTES * 2)
  assert.deepEqual(decodeAuthData(data), { purpose: 'signin', appPubKey: app, challengeHash: challenge() })
  for (const purpose of ['register', 'signin', 'refresh', 'write']) {
    assert.equal(decodeAuthData(encodeAuthData({ purpose, appPubKey: app, challengeHash: challenge() })).purpose, purpose)
  }
  assert.throws(() => decodeAuthData(data.slice(2)), /66 bytes/)
  assert.throws(() => decodeAuthData('09' + data.slice(2)), /unknown purpose/)
  assert.throws(() => decodeAuthData(data.slice(0, 2) + '05' + data.slice(4)), /app key/)
  assert.throws(() => encodeAuthData({ purpose: 'pay', appPubKey: app, challengeHash: challenge() }), /purpose/)
  assert.throws(() => encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: 'ab' }), /32 bytes/)
})

test('create: each identity is a new AuthBOLT under its own key, and its funding change is 1 sat', async () => {
  const chain = pretendChain()
  const { ids, calls } = identityOn(chain)
  const a = await ids.create()
  const b = await ids.create()
  assert.notEqual(a.issuer, b.issuer, 'a new key per identity')
  assert.equal(a.type, 'AuthBOLT')
  assert.notEqual(a.keyId, b.keyId)
  const mint = chain.txs.get(a.id.split('.')[0])
  assert.equal(mint.outputs.at(-1).satoshis, 1, 'funded exactly: nothing worth stranding on the identity key')
  assert.ok(calls.includes('createAction'))
  assert.equal((await ids.identities()).length, 2)
})

test('present: tags the identity for the app, and a relying party learns the issuer and the data; the token stays with its holder', async () => {
  const chain = pretendChain()
  const { ids } = identityOn(chain)
  const site = verifierOn(chain)
  const app = appKey()
  const id = await ids.create()
  const data = encodeAuthData({ purpose: 'register', appPubKey: app, challengeHash: challenge() })

  const { package: pkg, id: used } = await ids.present({ id: id.id, domain: SITE, appPubKey: app, data })
  assert.equal(used, id.id)
  const r = await verifyIdentity({ handler: site, package: pkg, appPubKey: app, data })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.issuer, id.issuer)
  assert.equal(r.purpose, 'register')
  const v = await site.verify(pkg, { issuer: id.issuer })
  assert.equal(v.owner, v.holder, 'a presentation is a self-transfer')

  assert.deepEqual((await ids.forApp({ domain: SITE, appPubKey: app })).map((t) => t.id), [id.id])
  assert.deepEqual(await ids.forApp({ domain: 'other.example', appPubKey: app }), [], 'another site sees nothing')
  assert.deepEqual(await ids.forApp({ domain: SITE, appPubKey: appKey() }), [], 'nor does another app on this site')
  assert.equal(chain.txs.has(fromBeef(pkg[0]).id('hex')), false, 'a presentation is never broadcast')
})

test('present: data that names another app, or is not auth data, is refused before anything is signed', async () => {
  const chain = pretendChain()
  const { ids, calls } = identityOn(chain)
  const app = appKey()
  const id = await ids.create()
  const before = calls.filter((c) => c === 'createSignature').length
  const foreign = encodeAuthData({ purpose: 'signin', appPubKey: appKey(), challengeHash: challenge() })
  await assert.rejects(ids.present({ id: id.id, domain: SITE, appPubKey: app, data: foreign }), /another app/)
  await assert.rejects(ids.present({ id: id.id, domain: SITE, appPubKey: app, data: 'ab'.repeat(20) }), /66 bytes/)
  await assert.rejects(ids.present({ id: id.id, domain: SITE, appPubKey: 'zz', data: foreign }), /app key/)
  assert.equal(calls.filter((c) => c === 'createSignature').length, before, 'nothing was signed')
})

test('verifyIdentity: refuses other data, another app, a transfer, and junk', async () => {
  const chain = pretendChain()
  const { ids } = identityOn(chain)
  const site = verifierOn(chain)
  const app = appKey()
  const id = await ids.create()
  const data = encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge() })
  const { package: pkg } = await ids.present({ id: id.id, domain: SITE, appPubKey: app, data })

  const other = encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge('other') })
  assert.match((await verifyIdentity({ handler: site, package: pkg, appPubKey: app, data: other })).reason, /data/)
  // The same package shown to a different app: the data names this app.
  const app2 = appKey()
  assert.equal((await verifyIdentity({ handler: site, package: pkg, appPubKey: app2, data })).ok, false)
  assert.equal((await verifyIdentity({ handler: site, package: ['00'], appPubKey: app, data })).ok, false)
})

test('verifyIdentity: the right data on a presentation that moves the token to another key is refused', async () => {
  const chain = pretendChain()
  const { ids, store, wallet } = identityOn(chain)
  const site = verifierOn(chain)
  const app = appKey()
  const id = await ids.create()
  const data = encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge() })
  // Built by hand with the identity's key, as a wallet that ignored the rule would: right data, but the
  // settle pays the app's key instead of the holder's own.
  const raw = new BoltHandler({ core: brc100Core({ wallet, broadcast: chain.broadcast, store, protocolID: IDENTITY_PROTOCOL }), keyId: id.holderKeyId })
  const { package: elsewhere } = await raw.present(id.id, { data, to: Hash.hash160(Utils.toArray(app, 'hex')) })
  assert.match((await verifyIdentity({ handler: site, package: elsewhere, appPubKey: app, data })).reason, /self-transfer/)
})

test('refresh: silent only for an app the user chose to stay signed in to, and only for keep-alive data', async () => {
  const chain = pretendChain()
  const { ids } = identityOn(chain)
  const site = verifierOn(chain)
  const app = appKey()
  const id = await ids.create()
  const signin = encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge() })
  const refresh = encodeAuthData({ purpose: 'refresh', appPubKey: app, challengeHash: challenge('r') })

  await ids.present({ id: id.id, domain: SITE, appPubKey: app, data: signin })
  await assert.rejects(ids.refresh({ domain: SITE, appPubKey: app, data: refresh }), (e) => e.code === 'NEEDS_PROMPT')

  await ids.present({ id: id.id, domain: SITE, appPubKey: app, data: signin, keepSignedIn: true })
  const { package: pkg } = await ids.refresh({ domain: SITE, appPubKey: app, data: refresh })
  assert.equal((await verifyIdentity({ handler: site, package: pkg, appPubKey: app, data: refresh })).ok, true)

  await assert.rejects(ids.refresh({ domain: SITE, appPubKey: app, data: signin }), /keep-alive/)
  await assert.rejects(ids.refresh({ domain: 'evil.example', appPubKey: app, data: refresh }), (e) => e.code === 'NEEDS_PROMPT')

  await ids.setKeepSignedIn({ id: id.id, domain: SITE, appPubKey: app, keep: false })
  await assert.rejects(ids.refresh({ domain: SITE, appPubKey: app, data: refresh }), (e) => e.code === 'NEEDS_PROMPT')
})

test('write: a signed change (tag 04) is presented silently under the same keep-signed-in grant, never otherwise', async () => {
  const chain = pretendChain()
  const { ids } = identityOn(chain)
  const site = verifierOn(chain)
  const app = appKey()
  const id = await ids.create()
  const signin = encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge() })
  const write = encodeAuthData({ purpose: 'write', appPubKey: app, challengeHash: challenge('a message') })
  assert.equal(write.slice(0, 2), '04')

  await ids.present({ id: id.id, domain: SITE, appPubKey: app, data: signin })
  await assert.rejects(ids.refresh({ domain: SITE, appPubKey: app, data: write }), (e) => e.code === 'NEEDS_PROMPT', 'no grant: no silent write')

  await ids.present({ id: id.id, domain: SITE, appPubKey: app, data: signin, keepSignedIn: true })
  const { package: pkg } = await ids.refresh({ domain: SITE, appPubKey: app, data: write })
  const r = await verifyIdentity({ handler: site, package: pkg, appPubKey: app, data: write })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.purpose, 'write', 'the app server learns it is a write, not a keep-alive')
  assert.equal(r.issuer, id.issuer)

  // A write is never prompted for: present() refuses it, so a page cannot turn it into a sign-in prompt.
  await assert.rejects(ids.present({ id: id.id, domain: SITE, appPubKey: app, data: write }), /silently/)
})

test('rotate: a self-transfer to a new holder key; the issuer, the tags and the app stay', async () => {
  const chain = pretendChain()
  const { ids } = identityOn(chain)
  const site = verifierOn(chain)
  const app = appKey()
  const id = await ids.create()
  await ids.present({ id: id.id, domain: SITE, appPubKey: app, data: encodeAuthData({ purpose: 'register', appPubKey: app, challengeHash: challenge() }) })

  const moved = await ids.rotate(id.id)
  assert.notEqual(moved.id, id.id)
  assert.equal(moved.issuer, id.issuer)
  assert.notEqual(moved.holderKeyId, id.keyId, 'a new holder key')
  assert.deepEqual((await ids.forApp({ domain: SITE, appPubKey: app })).map((t) => t.id), [moved.id], 'the tag moved with it')

  // A moved token proves no ownership any more (audit V1): a relying party refuses it, and the
  // wallet will not register it anywhere.
  const data = encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge('after') })
  const { package: pkg } = await ids.present({ id: moved.id, domain: SITE, appPubKey: app, data })
  const r = await verifyIdentity({ handler: site, package: pkg, appPubKey: app, data })
  assert.equal(r.ok, false)
  assert.match(r.reason, /mint/)
  const app2 = appKey()
  await assert.rejects(ids.present({ id: moved.id, domain: SITE, appPubKey: app2, data: encodeAuthData({ purpose: 'register', appPubKey: app2, challengeHash: challenge() }) }), /mint/)
})

// ---- holder-key signatures (PeerLoop's V1 plan): after registering, an app knows the identity's
// holder key, and sign-in, keep-alives and writes are that key's signatures over a digest the
// wallet builds itself. ----

const digestVectors = JSON.parse(readFileSync(new URL('./fixtures/sign-digests.json', import.meta.url), 'utf8'))

/** Does `signature` (DER hex) by `pubKey` (hex) cover `digest` (bytes)? */
const verifies = (pubKey, digest, signature) =>
  ECDSA.verify(new BigNumber(digest), Signature.fromDER(Utils.toArray(signature, 'hex')), PublicKey.fromString(pubKey))

/** An identity registered with an app, the person having chosen to stay signed in or not. */
async function registered (chain, { keep = true } = {}) {
  const w = identityOn(chain)
  const app = appKey()
  const id = await w.ids.create()
  await w.ids.present({ id: id.id, domain: SITE, appPubKey: app, data: encodeAuthData({ purpose: 'register', appPubKey: app, challengeHash: challenge() }), keepSignedIn: keep })
  return { ...w, app, id }
}

const writeOf = (kind) => JSON.stringify({ v: 1, kind, target: 'POST /x', body: {}, at: 1, seq: 1, sid: 's' })

test('signDigest: the digest is the contract\'s for every kind (computed independently, sign-digests.json)', () => {
  for (const c of digestVectors.cases) {
    assert.equal(hex(signDigest({ kind: c.kind, appPubKey: digestVectors.appPubKey, payload: c.payload })), c.digest, c.kind)
  }
  assert.throws(() => signDigest({ kind: 'pay', appPubKey: digestVectors.appPubKey, payload: 'x' }), /kind/)
  assert.throws(() => signDigest({ kind: 'signin', appPubKey: 'ab', payload: 'x' }), /app key/)
})

test('sign: under the keep-signed-in grant, sign-in, keep-alive and silent-tier writes are signed by the holder key, without asking', async () => {
  const chain = pretendChain()
  const { ids, app, id } = await registered(chain)
  for (const [kind, payload] of [['signin', '02aa'], ['refresh', '03bb'], ['write', writeOf('message.post')]]) {
    const s = await ids.sign({ domain: SITE, appPubKey: app, kind, payload, silent: true })
    assert.equal(s.identity, id.issuer, 'it names the identity (its issuer key)')
    assert.equal(s.holder, id.issuer, 'the holder key is the issuer key until the wallet rotates it')
    assert.ok(verifies(s.holder, signDigest({ kind, appPubKey: app, payload }), s.signature), kind)
  }
})

test('sign: never silently without the grant, for a prompted-tier or unknown write, for another site, or for rotate/recover', async () => {
  const chain = pretendChain()
  const { ids, app, id } = await registered(chain, { keep: false })
  const silent = (kind, payload, domain = SITE) => ids.sign({ domain, appPubKey: app, kind, payload, silent: true })
  await assert.rejects(silent('signin', '02aa'), (e) => e.code === 'NEEDS_PROMPT', 'no grant')
  await ids.setKeepSignedIn({ id: id.id, domain: SITE, appPubKey: app, keep: true })
  await assert.rejects(silent('write', writeOf('member.role')), (e) => e.code === 'NEEDS_PROMPT', 'a prompted-tier write')
  await assert.rejects(silent('write', writeOf('no.such.kind')), (e) => e.code === 'NEEDS_PROMPT', 'an unknown kind')
  await assert.rejects(silent('write', 'not json'), /write/)
  await assert.rejects(silent('signin', '02aa', 'evil.example'), (e) => e.code === 'NEEDS_PROMPT', 'another site')
  await assert.rejects(silent('rotate', '{}'), /rotate|recover|kind/)
  await assert.rejects(silent('signin', 'x'.repeat(65 * 1024)), /64 KiB/)
  // Behind the wallet's prompt (silent false, the person chose the identity), a prompted write is signed.
  const s = await ids.sign({ id: id.id, domain: SITE, appPubKey: app, kind: 'write', payload: writeOf('member.role'), silent: false })
  assert.ok(verifies(s.holder, signDigest({ kind: 'write', appPubKey: app, payload: writeOf('member.role') }), s.signature))
  await assert.rejects(ids.sign({ domain: SITE, appPubKey: app, kind: 'write', payload: writeOf('member.role'), silent: false }), /identity/, 'a prompted signature names its identity')
})

test('the write tiers are PeerLoop\'s published actions', { skip: !existsSync(new URL('../../../p2p/testdata/contract/api/actions.json', import.meta.url)) && 'no p2p clone here' }, () => {
  const { actions } = JSON.parse(readFileSync(new URL('../../../p2p/testdata/contract/api/actions.json', import.meta.url), 'utf8'))
  assert.deepEqual(WRITE_TIERS, Object.fromEntries(actions.map((a) => [a.kind, a.tier])))
})

test('rotateHolder: the current holder signs the move to a new key; it takes effect when the app has accepted it', async () => {
  const chain = pretendChain()
  const { ids, app, id } = await registered(chain)
  const r = await ids.rotateHolder({ id: id.id, domain: SITE, appPubKey: app })
  assert.equal(r.seq, 1)
  assert.notEqual(r.newHolder, id.issuer)
  const payload = `{"issuer":"${id.issuer}","newHolder":"${r.newHolder}","seq":1}`
  assert.ok(verifies(id.issuer, signDigest({ kind: 'rotate', appPubKey: app, payload }), r.signature), 'signed by the old holder, over the contract\'s JSON')
  let s = await ids.sign({ domain: SITE, appPubKey: app, kind: 'refresh', payload: '03', silent: true })
  assert.equal(s.holder, id.issuer, 'not yet: the app has not accepted it')
  await ids.confirmHolder({ id: id.id, domain: SITE, appPubKey: app })
  s = await ids.sign({ domain: SITE, appPubKey: app, kind: 'refresh', payload: '03', silent: true })
  assert.equal(s.holder, r.newHolder)
  assert.ok(verifies(r.newHolder, signDigest({ kind: 'refresh', appPubKey: app, payload: '03' }), s.signature))
  const again = await ids.rotateHolder({ id: id.id, domain: SITE, appPubKey: app })
  assert.equal(again.seq, 2)
  assert.ok(verifies(r.newHolder, signDigest({ kind: 'rotate', appPubKey: app, payload: `{"issuer":"${id.issuer}","newHolder":"${again.newHolder}","seq":2}` }), again.signature))
  await assert.rejects(ids.confirmHolder({ id: id.id, domain: 'evil.example', appPubKey: app }), /not linked|no rotation/)
})

test('recoverHolder: the issuer key signs a rebind over the app\'s challenge, whatever the holder key is', async () => {
  const chain = pretendChain()
  const { ids, app, id } = await registered(chain)
  await ids.rotateHolder({ id: id.id, domain: SITE, appPubKey: app })
  await ids.confirmHolder({ id: id.id, domain: SITE, appPubKey: app })
  const data = '02' + app + challenge('recover')
  const r = await ids.recoverHolder({ id: id.id, domain: SITE, appPubKey: app, challenge: data })
  assert.equal(r.seq, 2)
  const payload = `{"issuer":"${id.issuer}","newHolder":"${r.newHolder}","seq":2,"challenge":"${data}"}`
  assert.ok(verifies(id.issuer, signDigest({ kind: 'recover', appPubKey: app, payload }), r.signature), 'by the issuer key')
  await ids.confirmHolder({ id: id.id, domain: SITE, appPubKey: app })
  assert.equal((await ids.sign({ domain: SITE, appPubKey: app, kind: 'signin', payload: '02', silent: true })).holder, r.newHolder)
  // A recovery after the wallet lost its count: the app's seq can be given.
  assert.equal((await ids.recoverHolder({ id: id.id, domain: SITE, appPubKey: app, challenge: data, seq: 9 })).seq, 9)
})

test('verifyIdentity: a presentation must spend the token\'s own mint, carried in the package (audit V1)', async () => {
  const chain = pretendChain()
  const { ids } = identityOn(chain)
  const site = verifierOn(chain)
  const app = appKey()
  const id = await ids.create()
  const data = encodeAuthData({ purpose: 'register', appPubKey: app, challengeHash: challenge() })
  const { package: pkg } = await ids.present({ id: id.id, domain: SITE, appPubKey: app, data })
  const r = await verifyIdentity({ handler: site, package: pkg, appPubKey: app, data })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.mintTxid, id.id.split('.')[0], 'the verdict names the mint')
  assert.equal(r.holderPubKey, id.issuer, 'and the key that signed the commit')
})
