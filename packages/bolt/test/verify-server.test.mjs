// The relying party's sidecar: POST /verify runs verifyIdentity for an app server (p2pd) that cannot
// run b017 itself. Loopback only, a shared secret, small bodies, and plain JSON answers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import { BoltHandler, brc100Core, memoryStore } from '../src/index.js'
import { IDENTITY_PROTOCOL, IdentityWallet, encodeAuthData } from '../src/identity.js'
import { createVerifyServer, headersTracker } from '../src/verify-server.js'
import { pretendChain, protoWalletOn } from './harness.mjs'

const SECRET = 'test-secret-1234567'
const challenge = (t) => Utils.toHex(Hash.sha256(Utils.toArray(t, 'utf8')))

async function listen (server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

async function setup () {
  const chain = pretendChain()
  const user = protoWalletOn(chain).wallet
  const ids = new IdentityWallet({ core: brc100Core({ wallet: user, broadcast: chain.broadcast, store: memoryStore(), protocolID: IDENTITY_PROTOCOL }) })
  const site = new BoltHandler({ core: brc100Core({ wallet: protoWalletOn(chain).wallet, broadcast: chain.broadcast }) })
  const server = createVerifyServer({ handler: site, secret: SECRET })
  const url = await listen(server)
  const app = PrivateKey.fromRandom().toPublicKey().toString()
  const id = await ids.create()
  return { chain, ids, server, url, app, id }
}

const post = (url, body, { secret = SECRET, raw } = {}) => fetch(`${url}/verify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: raw ?? JSON.stringify(body)
})

test('POST /verify: a good presentation is ok, with the issuer the app records', async () => {
  const { ids, server, url, app, id } = await setup()
  const data = encodeAuthData({ purpose: 'register', appPubKey: app, challengeHash: challenge('n1') })
  const { package: pkg } = await ids.present({ id: id.id, domain: 'peerloop.example', appPubKey: app, data })
  const res = await post(url, { package: pkg, appPubKey: app, data })
  assert.equal(res.status, 200)
  const r = await res.json()
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.issuer, id.issuer)
  assert.equal(r.purpose, 'register')
  server.close()
})

test('POST /verify: a refusal is an ordinary answer with the reason', async () => {
  const { ids, server, url, app, id } = await setup()
  const data = encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge('n2') })
  const { package: pkg } = await ids.present({ id: id.id, domain: 'peerloop.example', appPubKey: app, data })
  const other = encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge('other') })
  const r = await (await post(url, { package: pkg, appPubKey: app, data: other })).json()
  assert.equal(r.ok, false)
  assert.match(r.reason, /other data/)
  server.close()
})

test('POST /verify: no secret, a wrong secret, a bad body, a big body and other paths are refused', async () => {
  const { server, url } = await setup()
  assert.equal((await post(url, {}, { secret: null })).status, 401)
  assert.equal((await post(url, {}, { secret: 'wrong-secret-456' })).status, 401)
  assert.equal((await post(url, null, { raw: '{not json' })).status, 400)
  assert.equal((await post(url, { package: 'x', appPubKey: 1, data: 2 })).status, 400)
  assert.equal((await post(url, null, { raw: JSON.stringify({ package: ['ab'.repeat(600000)], appPubKey: 'a', data: 'b' }) })).status, 413)
  assert.equal((await fetch(`${url}/other`, { method: 'POST' })).status, 404)
  assert.equal((await fetch(`${url}/verify`)).status, 405)
  assert.equal((await fetch(`${url}/healthz`)).status, 200)
  server.close()
})

test('createVerifyServer: refuses to start without a secret', () => {
  assert.throws(() => createVerifyServer({ handler: {}, secret: '' }), /secret/)
  assert.throws(() => createVerifyServer({ handler: {}, secret: 'short' }), /secret/)
})

test('headersTracker: asks the app server whether a root is in ITS verified chain', async () => {
  const asked = []
  const fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    asked.push([u.pathname, u.searchParams.get('height'), u.searchParams.get('root'), req.headers.authorization])
    const active = u.searchParams.get('root') === 'aa'.repeat(32)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ active, undecided: false }))
  })
  const url = await listen(fake)
  const isValid = headersTracker({ url, secret: SECRET })
  assert.equal(await isValid('aa'.repeat(32), 7), true)
  assert.equal(await isValid('bb'.repeat(32), 7), false)
  assert.deepEqual(asked[0], ['/headers/root', '7', 'aa'.repeat(32), `Bearer ${SECRET}`])
  fake.close()
  // An app server that cannot be reached is not a yes.
  assert.equal(await isValid('aa'.repeat(32), 7), false)
})
