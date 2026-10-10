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
import { appFunderOn, pretendChain, protoWalletOn } from './harness.mjs'

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
  for (const purpose of ['signin', 'refresh', 'write']) {
    assert.equal(decodeAuthData(encodeAuthData({ purpose, appPubKey: app, challengeHash: challenge() })).purpose, purpose)
  }
  assert.throws(() => decodeAuthData(data.slice(2)), /66 bytes/)
  assert.throws(() => decodeAuthData('09' + data.slice(2)), /unknown purpose/)
  assert.throws(() => decodeAuthData(data.slice(0, 2) + '05' + data.slice(4)), /app key/)
  assert.throws(() => encodeAuthData({ purpose: 'pay', appPubKey: app, challengeHash: challenge() }), /purpose/)
  assert.throws(() => encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: 'ab' }), /32 bytes/)
})

// The shared contract (p2p testdata/contract/authdata/authdata.json, computed with Python): register,
// rotate and reissue carry the holder count after the challenge hash (70 bytes); the rest do not (66).
const authDataVectors = JSON.parse(readFileSync(new URL('./fixtures/auth-data.json', import.meta.url), 'utf8'))

test('auth data: the contract vectors, counted (register, rotate, reissue) and not', () => {
  for (const c of authDataVectors.cases) {
    const fields = { purpose: c.purpose, appPubKey: c.appPubKey, challengeHash: c.challengeHash }
    if (c.count !== undefined) fields.count = c.count
    assert.equal(encodeAuthData(fields), c.hex, `${c.purpose} ${c.count ?? ''}`)
    assert.deepEqual(decodeAuthData(c.hex), fields, `${c.purpose} ${c.count ?? ''}`)
  }
  for (const c of authDataVectors.invalid) assert.throws(() => decodeAuthData(c.hex), undefined, c.why)
  const app = authDataVectors.cases[0].appPubKey
  assert.throws(() => encodeAuthData({ purpose: 'register', appPubKey: app, challengeHash: challenge() }), /count/, 'register needs a count')
  assert.throws(() => encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge(), count: 1 }), /count/, 'signin takes none')
  for (const count of [0, -1, 1.5, 2 ** 32]) {
    assert.throws(() => encodeAuthData({ purpose: 'rotate', appPubKey: app, challengeHash: challenge(), count }), /count/, `count ${count}`)
  }
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

test('present: data that names another app, or is not auth data, is refused before anything is signed', async () => {
  const chain = pretendChain()
  const { ids, calls } = identityOn(chain)
  const app = appKey()
  const id = await ids.create()
  const before = calls.filter((c) => c === 'createSignature').length
  const foreign = encodeAuthData({ purpose: 'signin', appPubKey: appKey(), challengeHash: challenge() })
  await assert.rejects(ids.present({ id: id.id, domain: SITE, appPubKey: app, data: foreign }), /another app/)
  await assert.rejects(ids.present({ id: id.id, domain: SITE, appPubKey: app, data: '02' + 'ab'.repeat(19) }), /66 bytes/)
  await assert.rejects(ids.present({ id: id.id, domain: SITE, appPubKey: 'zz', data: foreign }), /app key/)
  assert.equal(calls.filter((c) => c === 'createSignature').length, before, 'nothing was signed')
})

test('verifyIdentity: refuses other data, another app, sign-in data, and junk', async () => {
  const chain = pretendChain()
  const site = verifierOn(chain)
  const { app, data, pkg } = await registered(chain)
  const other = encodeAuthData({ purpose: 'register', appPubKey: app, challengeHash: challenge('other'), count: 1 })
  assert.match((await verifyIdentity({ handler: site, package: pkg, appPubKey: app, data: other })).reason, /data/)
  // The same package shown to a different app: the data names this app.
  const app2 = appKey()
  assert.equal((await verifyIdentity({ handler: site, package: pkg, appPubKey: app2, data })).ok, false)
  assert.equal((await verifyIdentity({ handler: site, package: ['00'], appPubKey: app, data })).ok, false)
  // Sign-in data registers nobody.
  const signin = encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge() })
  assert.match((await verifyIdentity({ handler: site, package: pkg, appPubKey: app, data: signin })).reason, /register/)
})

// ---- holder-key signatures (PeerLoop's V1 plan): after registering, an app knows the identity's
// holder key, and sign-in, keep-alives and writes are that key's signatures over a digest the
// wallet builds itself. ----

const digestVectors = JSON.parse(readFileSync(new URL('./fixtures/sign-digests.json', import.meta.url), 'utf8'))

/** Does `signature` (DER hex) by `pubKey` (hex) cover `digest` (bytes)? */
const verifies = (pubKey, digest, signature) =>
  ECDSA.verify(new BigNumber(digest), Signature.fromDER(Utils.toArray(signature, 'hex')), PublicKey.fromString(pubKey))

/** An identity registered with an app (on chain, paid by the app), the person having chosen to stay
 *  signed in or not. `id` is the identity as it is after registering (its token at holder 1). */
async function registered (chain, { keep = true } = {}) {
  const w = identityOn(chain)
  const { funder } = appFunderOn(chain)
  const app = appKey()
  const created = await w.ids.create()
  const data = encodeAuthData({ purpose: 'register', appPubKey: app, challengeHash: challenge(), count: 1 })
  const { package: pkg } = await w.ids.present({ id: created.id, domain: SITE, appPubKey: app, data, keepSignedIn: keep, funder })
  const [id] = await w.ids.identities()
  return { ...w, app, id, created, data, pkg, funder }
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
    assert.notEqual(s.holder, id.issuer, 'signed by the holder key the token moved to at registration, not the issuer key')
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

test('verifyIdentity: a registration must spend the token\'s own mint, carried in the package (audit V1)', async () => {
  const chain = pretendChain()
  const site = verifierOn(chain)
  const { store, wallet, app, id, created, data, pkg } = await registered(chain)
  const r = await verifyIdentity({ handler: site, package: pkg, appPubKey: app, data })
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.mintTxid, created.id.split('.')[0], 'the verdict names the mint')
  // Register data on the token as it now is (moved to holder 1): its commit spends a settle, not a mint.
  const raw = new BoltHandler({ core: brc100Core({ wallet, broadcast: chain.broadcast, store, protocolID: IDENTITY_PROTOCOL }), keyId: id.holderKeyId })
  const again = encodeAuthData({ purpose: 'register', appPubKey: app, challengeHash: challenge('again'), count: 1 })
  const { package: moved } = await raw.present(id.id, { data: again })
  assert.match((await verifyIdentity({ handler: site, package: moved, appPubKey: app, data: again })).reason, /mint/)
})

