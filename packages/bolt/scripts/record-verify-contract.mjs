// Record bolt-verify's answers for p2p's contract (p2p testdata/contract/verify/recorded.json).
//
//   node scripts/record-verify-contract.mjs <out.json>
//
// Each case keeps the request it sent (real packages), so a verifier ported to another language
// (b017-native's Go authbolt, in p2pd) can be run on the same packages and held to the same answers.
//
// The real sidecar (createVerifyServer + verifyIdentity) answers real registrations, made by an
// IdentityWallet on the package's pretend chain (test/harness.mjs) and paid by an app's funder: an
// accepted registration and reissue, and each way one is refused. p2p holds its sidecar client, its
// StubVerifier and boltverifyd to these answers.
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import { BoltHandler, brc100Core, memoryStore } from '../src/index.js'
import { IDENTITY_PROTOCOL, IdentityWallet, encodeAuthData } from '../src/identity.js'
import { createVerifyServer } from '../src/verify-server.js'
import { appFunderOn, pretendChain, protoWalletOn } from '../test/harness.mjs'

const out = process.argv[2]
if (!out) {
  console.error('usage: node scripts/record-verify-contract.mjs <out.json>')
  process.exit(2)
}

const SECRET = 'record-secret-123456'
const SITE = 'peerloop.example'
const challenge = (t) => Utils.toHex(Hash.sha256(Utils.toArray(t, 'utf8')))

function identityOn (chain) {
  const store = memoryStore()
  const { wallet } = protoWalletOn(chain)
  const ids = new IdentityWallet({ core: brc100Core({ wallet, broadcast: chain.broadcast, store, protocolID: IDENTITY_PROTOCOL }) })
  return { ids, wallet, store }
}

const chain = pretendChain()
const { ids, wallet, store } = identityOn(chain)
const site = new BoltHandler({ core: brc100Core({ wallet: protoWalletOn(chain).wallet, broadcast: chain.broadcast }) })
const server = createVerifyServer({ handler: site, secret: SECRET })
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`

const app = PrivateKey.fromRandom().toPublicKey().toString()
const otherApp = PrivateKey.fromRandom().toPublicKey().toString()
const { funder } = appFunderOn(chain)
const counted = (purpose, text, count) => encodeAuthData({ purpose, appPubKey: app, challengeHash: challenge(text), count })

// Registered on chain: the token moves from its mint to holder 1.
const id = await ids.create()
const register = counted('register', 'register', 1)
const { package: pkg } = await ids.present({ id: id.id, domain: SITE, appPubKey: app, data: register, keepSignedIn: true, funder })
const [moved] = await ids.identities()
// Reissued after a lost holder key: a new mint of the same issuer, moved to holder 2.
const reissue = counted('reissue', 'reissue', 2)
const { package: reissued } = await ids.reissue({ id: moved.id, domain: SITE, appPubKey: app, data: reissue, funder, silent: false })

// V1's shape: an unfunded self-transfer carrying register data, never broadcast.
const fresh = await ids.create()
const offChain = await ids.presentOffChain({ id: fresh.id, appPubKey: app, data: register })
// Register data presented from a token that has already moved (a wallet ignoring the rule would build it).
const [now] = (await ids.identities()).filter((t) => t.holderCount > 0)
const raw = new BoltHandler({ core: brc100Core({ wallet, broadcast: chain.broadcast, store, protocolID: IDENTITY_PROTOCOL }), keyId: now.holderKeyId })
const again = counted('register', 'again', 1)
const { package: fromMoved } = await raw.present(now.id, { data: again })

// An identity registered on another chain: the network the sidecar asks has never seen its moves.
const awayChain = pretendChain()
const away = identityOn(awayChain)
const awayId = await away.ids.create()
const { package: unseen } = await away.ids.present({ id: awayId.id, domain: SITE, appPubKey: app, data: register, funder: appFunderOn(awayChain).funder })

const signin = encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge('sign in') })
const cases = [
  ['accepted', { package: pkg, appPubKey: app, data: register }],
  ['accepted_reissue', { package: reissued, appPubKey: app, data: reissue }],
  ['other_data', { package: pkg, appPubKey: app, data: counted('register', 'another registration', 1) }],
  ['other_app', { package: pkg, appPubKey: otherApp, data: register }],
  ['bad_data', { package: pkg, appPubKey: app, data: 'abcd' }],
  ['signin_data', { package: pkg, appPubKey: app, data: signin }],
  ['invalid_package', { package: ['00', '00'], appPubKey: app, data: register }],
  ['off_chain', { package: offChain, appPubKey: app, data: register }],
  ['not_from_mint', { package: fromMoved, appPubKey: app, data: again }],
  ['anchor_unseen', { package: unseen, appPubKey: app, data: register }],
  ['bad_request', { package: 'not a list', appPubKey: app, data: register }],
  ['unauthorized', { package: pkg, appPubKey: app, data: register }, 'wrong-secret-0000000'],
]

const recorded = []
for (const [name, body, secret = SECRET] of cases) {
  const res = await fetch(`${url}/verify`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(body) })
  const response = await res.json()
  delete response.anchors // which txids anchored it: different every run, and p2p reads none
  recorded.push({ name, request: body, ...(secret !== SECRET ? { secret } : {}), status: res.status, response })
  console.log(`${name}: ${res.status} ${JSON.stringify(response)}`)
}
server.close()

writeFileSync(out, `${JSON.stringify({
  source: `recorded from bolt-verify (packages/bolt verify-server.js, verifyIdentity) on the pretend chain, ${new Date().toISOString().slice(0, 10)}`,
  appPubKey: app,
  cases: recorded,
}, null, 2)}\n`)
console.log(`wrote ${out}`)
