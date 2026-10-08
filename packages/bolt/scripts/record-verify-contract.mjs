// Record bolt-verify's answers for p2p's contract (p2p testdata/contract/verify/cases.json).
//
//   node scripts/record-verify-contract.mjs <out.json>
//
// The real sidecar (createVerifyServer + verifyIdentity) answers real presentations, made by an
// IdentityWallet on the package's pretend chain (test/harness.mjs): an accepted write, and each way
// one is refused. p2p holds both its sidecar client and its StubVerifier to these answers, so the
// stub can never say what the sidecar would not.
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { Hash, PrivateKey, Utils } from '@bsv/sdk'
import { BoltHandler, brc100Core, memoryStore } from '../src/index.js'
import { IDENTITY_PROTOCOL, IdentityWallet, encodeAuthData } from '../src/identity.js'
import { createVerifyServer } from '../src/verify-server.js'
import { pretendChain, protoWalletOn } from '../test/harness.mjs'

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
const id = await ids.create()
const signin = encodeAuthData({ purpose: 'signin', appPubKey: app, challengeHash: challenge('sign in') })
await ids.present({ id: id.id, domain: SITE, appPubKey: app, data: signin, keepSignedIn: true })
const write = encodeAuthData({ purpose: 'write', appPubKey: app, challengeHash: challenge('{"v":1,"kind":"message.post"}') })
const { package: pkg } = await ids.refresh({ domain: SITE, appPubKey: app, data: write })

// A presentation that moves the token to another key (a wallet ignoring the rule would build it).
const raw = new BoltHandler({ core: brc100Core({ wallet, broadcast: chain.broadcast, store, protocolID: IDENTITY_PROTOCOL }), keyId: id.holderKeyId })
const { package: elsewhere } = await raw.present(id.id, { data: write, to: Hash.hash160(Utils.toArray(otherApp, 'hex')) })

// An identity minted on another chain: its anchor was never seen where the sidecar asks.
const away = identityOn(pretendChain())
const awayId = await away.ids.create()
await away.ids.present({ id: awayId.id, domain: SITE, appPubKey: app, data: signin, keepSignedIn: true })
const { package: unseen } = await away.ids.refresh({ domain: SITE, appPubKey: app, data: write })

const other = encodeAuthData({ purpose: 'write', appPubKey: app, challengeHash: challenge('another write') })
const cases = [
  ['accepted', { package: pkg, appPubKey: app, data: write }],
  ['other_data', { package: pkg, appPubKey: app, data: other }],
  ['other_app', { package: pkg, appPubKey: otherApp, data: write }],
  ['bad_data', { package: pkg, appPubKey: app, data: 'abcd' }],
  ['invalid_package', { package: ['00', '00'], appPubKey: app, data: write }],
  ['not_self_transfer', { package: elsewhere, appPubKey: app, data: write }],
  ['anchor_unseen', { package: unseen, appPubKey: app, data: write }],
  ['bad_request', { package: 'not a list', appPubKey: app, data: write }],
  ['unauthorized', { package: pkg, appPubKey: app, data: write }, 'wrong-secret-0000000'],
]

const recorded = []
for (const [name, body, secret = SECRET] of cases) {
  const res = await fetch(`${url}/verify`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body: JSON.stringify(body) })
  const response = await res.json()
  delete response.anchors // which txids anchored it: different every run, and p2p reads none
  recorded.push({ name, status: res.status, response })
  console.log(`${name}: ${res.status} ${JSON.stringify(response)}`)
}
server.close()

writeFileSync(out, `${JSON.stringify({
  source: `recorded from bolt-verify (packages/bolt verify-server.js, verifyIdentity) on the pretend chain, ${new Date().toISOString().slice(0, 10)}`,
  appPubKey: app,
  cases: recorded,
}, null, 2)}\n`)
console.log(`wrote ${out}`)
