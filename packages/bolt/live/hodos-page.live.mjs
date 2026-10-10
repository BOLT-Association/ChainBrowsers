// Live: window.BOLT in a real page in the Hodos browser.
//
//   page  = https://bolt.test:8443/ in a Hodos tab: an external https origin, where the shim is
//           injected. This script serves it (a self-signed certificate, made on first run) and the
//           browser is started with the name mapped to this machine, so no internet is needed and
//           no real site is given access to the wallet. Everything the page does goes through the
//           browser's wallet bridge to the Hodos wallet.
//   site, user = handlers in this process on plain keys, talking to Arcade themselves: the other
//           party, who only ever sees the packages the page hands out
//
// The page cannot mint or present an AuthBOLT (identities are the wallet's own, behind its prompt:
// tests/authbolt/peerloop.live.mjs); it mints a fungible token and pays part of it; and after a
// reload still holds what it had (the tokens live in the wallet). Driven through the dev build's
// DevTools port, as a person typing in the console would.
//
//   tests/cross-wallet/start-hodos.ps1 -BrowserArgs '--host-resolver-rules="MAP bolt.test 127.0.0.1"','--ignore-certificate-errors'
//   node ../../tests/hodos-spv/fund.mjs       (stack up; funds the Hodos wallet)
//   node live/hodos-page.live.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hash, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { BoltHandler, PAGE_METHODS, brc100Core } from '../src/index.js'
import { approveDomain, autoApprove, evaluate, openTab, targets, wallet as walletHttp } from '../../../tests/cross-wallet/hodos.mjs'

const ARCADE = process.env.ARCADE_URL ?? 'http://localhost:8080'
const NAME = 'bolt.test'
const RUN = Date.now() // in the URLs, so tabs left open by an earlier run are not mistaken for this one's
const PAGE = `https://${NAME}:8443/?run=${RUN}`
const PLAIN = `http://${NAME}:8444/?run=${RUN}` // the same page without TLS: the control
const OUT = fileURLToPath(new URL('../../../tests/cross-wallet/out/bolt-page/', import.meta.url))

/** Serve the test page over https (self-signed, made once with openssl) and over plain http. */
function serve () {
  mkdirSync(OUT, { recursive: true })
  const [key, cert] = [join(OUT, 'key.pem'), join(OUT, 'cert.pem')]
  if (!existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-keyout', key, '-out', cert,
      '-subj', `/CN=${NAME}`, '-addext', `subjectAltName=DNS:${NAME}`], { stdio: 'ignore' })
  }
  const html = '<!doctype html><meta charset="utf-8"><title>BOLT test page</title><h1>BOLT test page</h1>'
  const answer = (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html) }
  const servers = [
    https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, answer).listen(8443, '127.0.0.1'),
    http.createServer(answer).listen(8444, '127.0.0.1')
  ]
  return () => servers.forEach((s) => { s.close(); s.closeAllConnections?.() })
}
const step = (m) => console.log('ok  ', m)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isPage = (u) => u.startsWith(PAGE)
/** Run an async function body in the page and return its (JSON) result. */
const inPage = (body) => evaluate(isPage, `(async () => { ${body} })()`)
async function pageReady (url = PAGE) {
  const at = (u) => u.startsWith(url)
  for (let i = 0; i < 60; i++) {
    if ((await targets()).filter((t) => at(t.url)).length === 1) {
      if ((await evaluate(at, 'document.readyState').catch(() => '')) === 'complete') return
    }
    await sleep(500)
  }
  throw new Error(`no loaded tab at ${url} (is the browser started with the host-resolver rule? see the top of this file)`)
}

/** The other party: plain keys, the Hodos wallet only for headers, Arcade for the network. */
const party = (trustedIssuers) => {
  const proto = new ProtoWallet(PrivateKey.fromRandom())
  const wallet = {
    getPublicKey: (a) => proto.getPublicKey(a),
    createSignature: (a) => proto.createSignature(a),
    getHeaderForHeight: async (a) => (await walletHttp('/getHeaderForHeight', a)).json
  }
  return new BoltHandler({ core: brc100Core({ wallet, arcadeUrl: ARCADE }), trustedIssuers })
}

const stopServing = serve()
await approveDomain(`${NAME}:8443`) // what the connect prompt does when the user approves the site
const approving = autoApprove({ onApprove: (r) => console.log(`     (clicked "${r.button}" on a wallet prompt: ${r.what.slice(0, 90)})`) })
try {
  // Negative control: the same page over plain http loads, and has no BOLT (the shim is https-only).
  await openTab(PLAIN)
  await pageReady(PLAIN)
  assert.equal(await evaluate((u) => u.startsWith(PLAIN), 'document.title'), 'BOLT test page') // it really loaded
  assert.equal(await evaluate((u) => u.startsWith(PLAIN), 'typeof window.BOLT'), 'undefined')
  step(`control: ${PLAIN} loads and has no window.BOLT`)

  await openTab(PAGE)
  await pageReady()
  assert.equal(await evaluate(isPage, 'document.title'), 'BOLT test page')
  const methods = await evaluate(isPage, 'typeof window.BOLT === "object" ? Object.keys(window.BOLT).sort().join(",") : "absent"')
  assert.equal(methods, Object.keys(PAGE_METHODS).sort().join(','))
  step(`${PAGE} has window.BOLT (${methods})`)

  const key = await inPage('return window.BOLT.getKey()')
  assert.equal(key.pubKeyHash, Utils.toHex(Hash.hash160(Utils.toArray(key.publicKey, 'hex'))))
  step(`getKey() from the page: ${key.publicKey.slice(0, 16)}… (the wallet's key, over the bridge)`)

  // --- AuthBOLT: identities are the wallet's. The page cannot mint or present one: it can only ask
  // Hodos's own prompt (requestPresentation), which tests/authbolt/peerloop.live.mjs drives. ---
  assert.equal(await evaluate(isPage, 'typeof window.BOLT.present'), 'undefined')
  assert.match(await inPage('try { await window.BOLT.mint({ type: "AuthBOLT" }); return "minted" } catch (e) { return e.message }'), /minted by the wallet/)
  step('the page cannot mint or present an AuthBOLT (identities belong to the wallet; see tests/authbolt)')

  // --- fungible: mint 1000 in the page, pay 300 to a user outside the browser ---
  // (the wallet may hold tokens from earlier runs: amounts are checked against what it had)
  const fungible = async () => BigInt(await inPage(
    `return (await window.BOLT.list()).filter((r) => r.type === "SimpleMultiBOLT" && r.issuer === ${JSON.stringify(key.publicKey)}).reduce((sum, r) => sum + BigInt(r.amount), 0n).toString()`))
  const before = await fungible()
  await inPage('return window.BOLT.mint({ type: "SimpleMultiBOLT", amount: "1000" })')
  const user = party([key.publicKey])
  const userPub = (await user.getKey()).publicKey
  const paid = await inPage(`return (await window.BOLT.pay(${JSON.stringify(key.publicKey)}, "300", ${JSON.stringify(userPub)})).package`)
  const got = await user.receive(paid)
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.kind, 'split')
  assert.equal(await user.balance(key.publicKey), '300')
  step('the page minted 1000 and paid 300 by split; a user outside the browser received it')

  assert.equal(await fungible(), before + 700n)

  // --- the tokens live in the wallet: reload the page and they are still there, and spendable ---
  await evaluate(isPage, 'location.reload(); true').catch(() => {})
  await sleep(1500)
  await pageReady()
  assert.equal(await fungible(), before + 700n)
  const paid2 = await inPage(`return (await window.BOLT.pay(${JSON.stringify(key.publicKey)}, "200", ${JSON.stringify(userPub)})).package`)
  assert.equal((await user.receive(paid2)).ok, true)
  assert.equal(await user.balance(key.publicKey), '500')
  assert.equal(await fungible(), before + 500n)
  step('after a reload the page still holds its tokens (kept by the wallet) and paid 200 more')

  const table = (await walletHttp('/boltTokens', { op: 'list', status: 'spent' })).json
  const heldRows = (await walletHttp('/boltTokens', { op: 'list' })).json
  step(`the wallet's bolt_tokens: ${heldRows.rows.length} held, ${table.rows.length} spent rows kept`)
  console.log('PASS window.BOLT in a Hodos page')
} finally {
  approving()
  stopServing()
}
