// The handler end to end against b017, with no network: each wallet is the SDK's ProtoWallet (a real
// BRC-100 key and signature implementation) behind `brc100Core`, on a shared pretend chain that supplies
// funding, headers and a broadcaster that refuses what a node would refuse.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Hash, PrivateKey, Script, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { fromBeef, toAtomicBeef } from 'b017'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatcher, nodeSqliteStore, pageClient } from '../src/index.js'
import { pretendChain, walletOn } from './harness.mjs'

async function issued (type = 'AuthBOLT') {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey] })
  const site = walletOn(chain, { trustedIssuers: [issuerKey] })
  const minted = await issuer.handler.mint({ type })
  const { package: pkg } = await issuer.handler.transfer(minted.id, (await user.handler.getKey()).pubKeyHash)
  const got = await user.handler.receive(pkg)
  assert.equal(got.ok, true, got.reason)
  return { chain, issuer, user, site, issuerKey, tokenId: got.tokenId }
}

test('the wallet is asked for four BRC-100 methods and nothing else', async () => {
  const { issuer, user } = await issued()
  const allowed = ['createAction', 'createSignature', 'getHeaderForHeight', 'getPublicKey']
  for (const w of [issuer, user]) assert.deepEqual(w.calls.filter((m) => !allowed.includes(m)), [])
  assert.ok(issuer.calls.includes('createAction') && issuer.calls.includes('createSignature'))
  assert.equal(user.calls.includes('createAction'), false) // receiving costs the receiver nothing
})

test('mint, transfer and receive: the issuer hands a token to a user', async () => {
  const { chain, issuer, user, issuerKey, tokenId } = await issued()
  assert.deepEqual(await issuer.handler.list(), [])
  assert.deepEqual(await user.handler.list(), [{ id: tokenId, type: 'AuthBOLT', issuer: issuerKey }])
  // the mint, the commit and the settle all reached the network
  assert.equal(chain.seen.has(tokenId.split('.')[0]), true)
})

test('present: a site learns the holder controls an issuer token and chose the challenge', async () => {
  const { chain, user, site, issuerKey, tokenId } = await issued()
  const challenge = Utils.toHex(Hash.sha256(Utils.toArray('login to example.com at 12:00', 'utf8'))) // 32 bytes
  const before = chain.seen.size
  const { package: pkg } = await user.handler.present(tokenId, { data: challenge })
  const r = await site.handler.verify(pkg)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.kind, 'presentation')
  assert.equal(r.type, 'AuthBOLT')
  assert.equal(r.issuer, issuerKey)
  assert.equal(r.data, challenge)
  assert.equal(r.holder, (await user.handler.getKey()).pubKeyHash)
  assert.equal(chain.seen.size, before) // nothing new was broadcast
  assert.equal((await user.handler.list()).length, 1) // and the token is still held: it can be presented again
  const again = await site.handler.verify((await user.handler.present(tokenId, { data: 'beef' })).package)
  assert.equal(again.data, 'beef')
})

test('present: a tampered challenge, a foreign issuer and a stranger are all refused', async () => {
  const { chain, user, site, tokenId } = await issued()
  const { package: pkg } = await user.handler.present(tokenId, { data: '01'.repeat(20) })

  // swap the data in the commit: its txid moves, so the settle no longer spends it
  const commit = fromBeef(pkg[0])
  const chunks = [...commit.inputs[0].unlockingScript.chunks]
  chunks[0] = new Script().writeBin(Utils.toArray('02'.repeat(20), 'hex')).chunks[0]
  commit.inputs[0].unlockingScript = new UnlockingScript(chunks)
  const tampered = await site.handler.verify([Utils.toHex(toAtomicBeef(commit)), pkg[1]])
  assert.equal(tampered.ok, false)

  const wrongIssuer = await site.handler.verify(pkg, { issuer: '02' + '11'.repeat(32) })
  assert.match(wrongIssuer.reason, /not trusted/)

  // a stranger mints a look-alike naming their own key as issuer: refused by the issuer pin
  const stranger = walletOn(chain)
  const own = await stranger.handler.mint()
  const selfIssued = await stranger.handler.transfer(own.id, (await stranger.handler.getKey()).pubKeyHash)
  assert.match((await site.handler.verify(selfIssued.package)).reason, /not trusted/)

  assert.equal((await site.handler.verify(['00'])).ok, false) // junk is refused, not thrown
})

test('a presentation cannot be kept as a transfer, and a transfer to someone else is not kept', async () => {
  const { issuer, user, site, tokenId } = await issued()
  const { package: shown } = await user.handler.present(tokenId, { data: 'aa', to: (await site.handler.getKey()).pubKeyHash })
  assert.match((await site.handler.receive(shown)).reason, /presentation/)
  const fresh = await issuer.handler.mint()
  const { package: pkg } = await issuer.handler.transfer(fresh.id, (await user.handler.getKey()).pubKeyHash)
  assert.match((await site.handler.receive(pkg)).reason, /not addressed/)
})

test('a second hop: the user transfers on, which co-spends the proof and rebuilds the earlier commit', async () => {
  const { user, site, issuerKey, tokenId } = await issued()
  const { package: pkg } = await user.handler.transfer(tokenId, (await site.handler.getKey()).pubKeyHash)
  const got = await site.handler.receive(pkg)
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.kind, 'transfer')
  assert.deepEqual(await user.handler.list(), [])
  assert.deepEqual(await site.handler.list(), [{ id: got.tokenId, type: 'AuthBOLT', issuer: issuerKey }])
  // and the new holder can present from there (a settle with a proof input, unfunded)
  const shown = await user.handler.verify((await site.handler.present(got.tokenId, { data: 'c0ffee' })).package)
  assert.equal(shown.ok, true, shown.reason)
  assert.equal(shown.data, 'c0ffee')
})

test('MinSimpleBOLT transfers the same way and cannot be presented', async () => {
  const { user, tokenId } = await issued('MinSimpleBOLT')
  assert.equal((await user.handler.list())[0].type, 'MinSimpleBOLT')
  await assert.rejects(user.handler.present(tokenId, { data: 'aa' }), /only AuthBOLT/)
})

test('limits: data over 75 bytes, an unknown token, an unheld type', async () => {
  const { user, tokenId } = await issued()
  await assert.rejects(user.handler.present(tokenId, { data: 'ab'.repeat(76) }), /maximum is 75/)
  await assert.rejects(user.handler.present('00'.repeat(32) + '.0', {}), /no token/)
  await assert.rejects(user.handler.mint({ type: 'NopeBOLT' }), /supported types/)
})

test('a page reaches the handler through the dispatcher, and the user is asked before anything is signed', async () => {
  const { user, site, tokenId } = await issued()
  const asked = []
  let answer = true
  const serve = dispatcher({ handler: user.handler, approve: async (q) => { asked.push(q); return answer } })
  const BOLT = pageClient((request) => serve('https://example.com', JSON.parse(JSON.stringify(request))))

  assert.equal((await BOLT.getKey()).pubKeyHash.length, 40)
  assert.equal((await BOLT.list()).length, 1)
  assert.deepEqual(asked, []) // reading asks nothing

  assert.equal(BOLT.present, undefined, 'a page cannot present an identity')
  await assert.rejects(BOLT.mint(), /minted by the wallet/)
  await BOLT.mint({ type: 'MinSimpleBOLT' })
  assert.equal(asked.length, 1)
  assert.equal(asked[0].origin, 'https://example.com')
  assert.match(asked[0].summary, /mint a new MinSimpleBOLT/)
  const seen = await pageClient((request) => dispatcher({ handler: site.handler, approve: async () => true })('https://rp.example', request))
    .verify((await user.handler.present(tokenId, { data: 'c0de' })).package)
  assert.equal(seen.data, 'c0de')
  assert.equal('txs' in seen, false)

  answer = false
  await assert.rejects(BOLT.transfer(tokenId, '00'.repeat(20)), /declined/)
  assert.equal((await BOLT.list()).length, 2)
  await assert.rejects(pageClient((r) => serve('https://example.com', { ...r, method: 'core' }))['getKey'](), /unsupported method/)
  await assert.rejects(pageClient((r) => serve('https://example.com', { ...r, method: 'constructor' }))['getKey'](), /unsupported method/)
})

test('a kept token records everything known about its anchor: a mint anchor, then a settle anchor + provenance', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey] })

  const minted = await issuer.handler.mint({ type: 'AuthBOLT' })
  const mrec = await issuer.store.get(minted.id)
  assert.equal(mrec.anchor.kind, 'mint')
  assert.ok(['accepted', 'already-seen'].includes(mrec.anchor.network), mrec.anchor.network)
  assert.equal(mrec.anchor.txid, minted.id.split('.')[0])
  assert.equal(mrec.type, 'AuthBOLT')
  assert.equal(mrec.issuer, issuerKey)
  assert.equal(mrec.owner, (await issuer.handler.getKey()).pubKeyHash)

  const { package: pkg } = await issuer.handler.transfer(minted.id, (await user.handler.getKey()).pubKeyHash)
  assert.equal(await issuer.store.get(minted.id), undefined) // the token left the issuer on transfer

  const got = await user.handler.receive(pkg)
  const rec = await user.store.get(got.tokenId)
  assert.equal(rec.anchor.kind, 'settle')
  assert.equal(rec.anchor.txid, got.tokenId.split('.')[0])
  assert.ok(['accepted', 'already-seen'].includes(rec.anchor.network), rec.anchor.network)
  assert.equal(rec.anchor.proven, false) // freshly broadcast, not yet mined
  assert.equal(rec.provenance.kind, 'mint') // the package stood on the mint
  assert.match(rec.provenance.txid, /^[0-9a-f]{64}$/)
  assert.equal(rec.owner, (await user.handler.getKey()).pubKeyHash)
})

test('the handler persists tokens in a sqlite store across a reopen', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'bolt-')), 'bolt.db')
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey], store: nodeSqliteStore(file) })

  const minted = await issuer.handler.mint({ type: 'AuthBOLT' })
  const { package: pkg } = await issuer.handler.transfer(minted.id, (await user.handler.getKey()).pubKeyHash)
  const got = await user.handler.receive(pkg)
  assert.equal(got.ok, true, got.reason)
  user.store.close()

  const reopened = nodeSqliteStore(file) // same file, fresh connection
  const rec = await reopened.get(got.tokenId)
  assert.ok(rec, 'the token survived the reopen')
  assert.equal(rec.type, 'AuthBOLT')
  assert.equal(rec.issuer, issuerKey)
  assert.equal(rec.anchor.kind, 'settle')
  assert.equal((await reopened.list()).length, 1)
  reopened.close()
})
