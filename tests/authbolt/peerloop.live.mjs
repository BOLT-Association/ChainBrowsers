// Live: PeerLoop registration and sign-in with an AuthBOLT, in the real Hodos browser.
//
// Everything is real except the names: Hodos in spv mode on the regtest stack (its own verified
// header chain, Arcade only), p2pd with its own verified header chain synced from Arcade's
// chaintracks, which asks boltverifyd to check presentations (the Go port of b017: roots judged by
// p2pd's chain, Arcade asked only whether an anchor was seen; VERIFIER=sidecar uses the Node sidecar), and the
// person's clicks in Hodos's own identity prompt. PeerLoop is served over https as app.lab, a made-up
// name the browser maps to this machine (so window.BOLT is injected and no real site is involved).
//
// Negative control: NC_NO_VERIFIER=1 must make it fail (see NC).
//
// What it shows, in order:
//   1. the page has window.BOLT with requestPresentation and no present; an AuthBOLT cannot be
//      minted from the page;
//   2. registering: the person fills the form, Hodos's prompt offers a new identity for this site,
//      the person creates it; the server verifies the presentation and (an admin's name) approves;
//   3. signing in again after signing out: the prompt offers the identity linked to this site;
//   4. the keep-alive: a refresh presentation with no prompt shown, accepted by the server;
//   4b. a signed write: a message sent from the composer is signed silently by the wallet (no prompt),
//      stored only once the server verified it, and its proof names the same identity;
//   5. refusals: a made-up presentation, and a presentation answering another challenge.
//
// Before running: the stack up (spv-testnet/stack), Hodos started with
//   tests/cross-wallet/start-hodos.ps1 -BrowserArgs '--host-resolver-rules="MAP app.lab 127.0.0.1"','--ignore-certificate-errors'
// and funded (node tests/hodos-spv/fund.mjs), p2pd built (cd p2p && go build -o results/p2pd.exe ./cmd/p2pd).
//
//   node tests/authbolt/peerloop.live.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { PrivateKey } from '../../packages/bolt/node_modules/@bsv/sdk/dist/esm/mod.js'
import { capture, evaluate, openTab, targets } from '../cross-wallet/hodos.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(ROOT, 'tests/cross-wallet/out/authbolt')
const RUN = String(Date.now()).slice(-6)
const NAME = 'app.lab'
const PORT = 8443
const PAGE = `https://${NAME}:${PORT}/?run=${RUN}` // its own address: tabs from earlier runs are not this one
const ADMIN = `admin-${RUN}`
const RQLITE_PORT = 14023
const CHAINTRACKS = 'http://127.0.0.1:8083/chaintracks/v2'
const SECRET = randomBytes(24).toString('hex')
const APP_KEY = PrivateKey.fromRandom().toPublicKey().toString()
// Who checks presentations for p2pd: boltverifyd (default) or the bolt-verify sidecar (VERIFIER=sidecar).
const SIDECAR = process.env.VERIFIER === 'sidecar'
// Negative control (NC_NO_VERIFIER=1): nothing p2pd is shown can be checked, so the run must FAIL at
// registration. The verifier can reach neither Arcade (is the anchor seen?) nor p2pd's header chain
// (so no merkle path proves anything). A pass with this set would mean the test does not depend on
// the presentations being verified.
const NC = !!process.env.NC_NO_VERIFIER
const NOWHERE = 'http://127.0.0.1:1'

const step = (m) => console.log('ok  ', m)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (what, fn, ms = 60000, every = 400) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = e }
    await sleep(every)
  }
  throw new Error(`timed out waiting for ${what} (last: ${last?.message ?? JSON.stringify(last)})`)
}

mkdirSync(OUT, { recursive: true })
const children = []
function start (name, cmd, args, env = {}) {
  const log = createWriteStream(join(OUT, `${name}.log`))
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: ROOT, windowsHide: true })
  p.stdout.pipe(log)
  p.stderr.pipe(log)
  children.push(p)
  return p
}
function stopAll () {
  for (const p of children) { try { p.kill() } catch {} }
  try { execFileSync('docker', ['rm', '-f', 'cb-authbolt-rqlite'], { stdio: 'ignore' }) } catch {}
}
process.on('exit', stopAll)

// ---- the pieces: rqlite (throwaway), p2pd over https (and the sidecar with VERIFIER=sidecar) --------
const cert = join(OUT, 'app.pem')
const key = join(OUT, 'app-key.pem')
if (!existsSync(cert)) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-keyout', key, '-out', cert,
    '-subj', `/CN=${NAME}`, '-addext', `subjectAltName=DNS:${NAME}`], { stdio: 'ignore' })
}
const secretFile = join(OUT, 'bolt-secret')
writeFileSync(secretFile, SECRET + '\n')

try { execFileSync('docker', ['rm', '-f', 'cb-authbolt-rqlite'], { stdio: 'ignore' }) } catch {}
execFileSync('docker', ['run', '-d', '--rm', '--name', 'cb-authbolt-rqlite', '-p', `127.0.0.1:${RQLITE_PORT}:4001`, 'rqlite/rqlite:10.3.7'], { stdio: 'ignore' })
await until('rqlite', async () => (await fetch(`http://127.0.0.1:${RQLITE_PORT}/readyz`)).ok)

const headersFile = join(OUT, 'headers.txt')
rmSync(headersFile, { force: true })
// p2pd always asks a verifier service on :8097 and answers its root questions on :8099; it links no
// token-script code of its own. The default verifier is boltverifyd (p2p, the Go b017 port);
// VERIFIER=sidecar runs the Node bolt-verify sidecar instead. The negative control cuts the
// verifier off from Arcade and chaintracks, so no presentation can be confirmed and registration
// must fail.
start('p2pd', join(ROOT, 'p2p/results/p2pd.exe'), [
  '-addr', `127.0.0.1:${PORT}`, '-cert', cert, '-key', key, '-web', join(ROOT, 'p2p/web'), '-results', '',
  '-rqlite-url', `http://127.0.0.1:${RQLITE_PORT}`, '-admins', ADMIN, '-app-key', APP_KEY,
  '-bolt-verify-url', 'http://127.0.0.1:8097', '-bolt-secret-file', secretFile,
  '-chaintracks-url', CHAINTRACKS, '-internal-addr', '127.0.0.1:8099', '-headers-file', headersFile,
])
if (SIDECAR) {
  start('bolt-verify', 'node', ['packages/bolt/bin/bolt-verify.mjs'], {
    BOLT_VERIFY_SECRET: SECRET, ARCADE_URL: NC ? NOWHERE : 'http://localhost:8080', HEADERS_URL: 'http://127.0.0.1:8099', BOLT_VERIFY_PORT: '8097',
  })
} else {
  execFileSync('go', ['build', '-o', join(ROOT, 'p2p/boltverifyd/boltverifyd.exe'), './boltverifyd'], { cwd: join(ROOT, 'p2p'), stdio: 'inherit' })
  start('boltverifyd', join(ROOT, 'p2p/boltverifyd/boltverifyd.exe'), [
    '-addr', '127.0.0.1:8097', '-secret-file', secretFile,
    '-arcade-url', NC ? NOWHERE : 'http://localhost:8080',
    '-headers-url', NC ? NOWHERE : 'http://127.0.0.1:8099',
  ])
}

// p2pd's own header chain must reach the tip before a presentation's anchor can be judged.
const tip = (await (await fetch(`${CHAINTRACKS}/height`)).json()).height
{
  const ownTip = await until(`p2pd's header chain to reach ${tip}`, async () => {
    const r = await fetch(`http://127.0.0.1:8099/headers/root?height=0&root=${'00'.repeat(32)}`, { headers: { authorization: `Bearer ${SECRET}` } })
    const j = await r.json()
    return j.tip >= tip ? j.tip : null
  }, 180000, 1000)
  step(`p2pd synced its own verified header chain to ${ownTip} (chaintracks said ${tip}); the verifier asks it, not Arcade`)
}

// ---- the page ----------------------------------------------------------------------------------------
const isPage = (u) => u.startsWith(PAGE) && !u.endsWith('/sw.js') // not the page's service worker
const inPage = (body) => evaluate(isPage, `(async () => { ${body} })()`)
const screen = () => evaluate(isPage, 'document.documentElement.dataset.screen')
const prompt = '/brc100-auth'
const promptText = () => evaluate(prompt, 'document.body.innerText')
/** Click the prompt's button with this label, once it is enabled. */
const clickPrompt = (label) => until(`the prompt's "${label}" button`, () => evaluate(prompt, `(function () {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === ${JSON.stringify(label)} && !x.disabled && x.offsetParent !== null)
  if (!b) return null
  b.click()
  return true
})()`), 60000)

await openTab(PAGE)
await until('the PeerLoop homepage', async () => (await screen()) === 'welcome')
const api = await inPage('return { BOLT: typeof window.BOLT, request: typeof window.BOLT?.requestPresentation, present: typeof window.BOLT?.present }')
assert.deepEqual(api, { BOLT: 'object', request: 'function', present: 'undefined' })
const minted = await inPage('try { await window.BOLT.mint({ type: "AuthBOLT" }); return "minted" } catch (e) { return e.message }')
assert.match(minted, /minted by the wallet/)
step('the page has window.BOLT.requestPresentation and no present; it cannot mint an AuthBOLT')

// ---- 2. register: the person creates a new identity for this site in Hodos's prompt -----------------
await evaluate(isPage, 'document.getElementById("welcome-register").click(); true')
await until('the registration form', async () => evaluate(isPage, '!document.getElementById("register-form").hidden'))
await inPage(`
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
  set('register-name', ${JSON.stringify(ADMIN)}); set('register-x', '@peerloop_${RUN}')
  document.getElementById('register-form').requestSubmit(); return true`)
const registerPrompt = await until('Hodos\'s identity prompt to register', async () => {
  const t = await promptText().catch(() => '')
  return /Create an account on app\.lab/.test(t) && /A new identity for this site/.test(t) ? t : null
})
await capture(prompt, join(OUT, '1-register-prompt.png')).catch(() => {})
assert.match(registerPrompt, /with an AuthBOLT identity/)
step('Hodos showed its own prompt: "Create an account on app.lab", offering a new identity for this site')
await clickPrompt('Create account')

// An admin's name is approved at once; the page then signs in, which asks the person again.
await until('the sign-in prompt after registering', async () => /Sign in on app\.lab/.test(await promptText().catch(() => '')) || null, 120000)
await capture(prompt, join(OUT, '2-signin-prompt.png')).catch(() => {})
assert.match(await promptText(), /Your identity for this site/)
step('registered: the server verified the presentation (its chain, Arcade for the anchor) and approved the admin; now "Sign in on app.lab" offers the linked identity')
await clickPrompt('Sign in')
await until('the workspace', async () => (await screen()) === 'workspace', 60000)
const me = await inPage('return (await fetch("/api/me")).json()')
assert.equal(me.name, ADMIN)
assert.match(me.identity, /^0[23][0-9a-f]{64}$/)
assert.equal(me.links.x, `peerloop_${RUN}`)
await capture(isPage, join(OUT, '3-workspace.png')).catch(() => {})
step(`signed in as ${me.name}, identity ${me.identity.slice(0, 12)}…, X @${me.links.x}`)

// ---- 4. keep-alive: a refresh presentation with no prompt shown ---------------------------------------
const refreshed = await inPage(`
  const ch = await (await fetch('/api/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'refresh' }) })).json()
  const shown = await window.BOLT.requestPresentation({ appPubKey: ch.appKey, data: ch.data, purpose: 'refresh', silent: true })
  const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: ch.id, package: shown.package }) })
  return { status: r.status, body: await r.json() }`)
assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body))
assert.equal(refreshed.body.identity, me.identity)
assert.doesNotMatch(await promptText().catch(() => ''), /Sign in on app\.lab/, 'no prompt was shown for the keep-alive')
step('keep-alive: a silent presentation renewed the session (the person chose "keep me signed in"), no prompt shown')

// ---- 4b. a signed write: the app's own composer, the wallet's silent signature, the server's check ----
const text = `signed hello ${RUN}`
await inPage(`
  document.querySelector('#channel-list [data-channel="1"]').click()
  await new Promise((r) => setTimeout(r, 300))
  document.getElementById('channel-input').value = ${JSON.stringify(text)}
  document.getElementById('channel-form').requestSubmit()
  return true`)
const sent = await until('the message to be signed and stored', async () => {
  const page = await inPage('return (await fetch("/api/channels/1/messages?limit=20")).json()')
  return page.messages?.find((m) => m.text === text && m.signed)
})
const proof = await inPage(`return (await fetch('/api/messages/${sent.id}/proof')).json()`)
const signedWrite = JSON.parse(proof.write)
assert.equal(proof.issuer, me.identity, 'the write is signed by the account\'s own identity')
assert.equal(signedWrite.kind, 'message.post')
assert.equal(signedWrite.body.text, text)
assert.equal(signedWrite.target, 'POST /api/channels/1/messages')
assert.doesNotMatch(await promptText().catch(() => ''), /Sign in on app\.lab/, 'no prompt was shown for the write')
await capture(isPage, join(OUT, '4b-signed-message.png')).catch(() => {})
step(`a message from the composer was signed silently, verified by ${SIDECAR ? 'the sidecar' : 'p2pd'} and stored with its proof (issuer ${proof.issuer.slice(0, 12)}…)`)

// ---- 3. sign out, sign in again: the linked identity is offered -------------------------------------
await inPage('await fetch("/api/auth/logout", { method: "POST" }); location.reload(); return true').catch(() => {})
await until('the homepage after signing out', async () => (await screen()) === 'welcome')
await evaluate(isPage, 'document.getElementById("welcome-signin").click(); true')
await until('the sign-in button', async () => evaluate(isPage, '!document.getElementById("signin-submit").disabled'))
await evaluate(isPage, 'document.getElementById("signin-submit").click(); true')
await until('the sign-in prompt', async () => /Sign in on app\.lab/.test(await promptText().catch(() => '')) || null)
await clickPrompt('Sign in')
await until('the workspace again', async () => (await screen()) === 'workspace', 60000)
assert.equal((await inPage('return (await fetch("/api/me")).json()')).identity, me.identity)
step('signed out and in again with the same identity: the account is the identity, no password anywhere')

// ---- 5. refusals ------------------------------------------------------------------------------------
const refusals = await inPage(`
  const post = async (path, body) => { const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  const ch = await post('/api/auth/challenge', { purpose: 'signin' })
  const forged = await post('/api/auth/signin', { challenge: ch.body.id, package: ['0100beef00', '0100beef01'] })
  return { forged }`)
assert.equal(refusals.forged.status, 401, JSON.stringify(refusals.forged))
assert.equal(refusals.forged.body.error, 'not_verified')
step(`a made-up presentation is refused: ${refusals.forged.body.message.slice(0, 90)}`)

console.log(`\nPASS AuthBOLT registration, sign-in, keep-alive and a signed write on PeerLoop in Hodos (screenshots and logs in ${OUT})`)
stopAll()
process.exit(0)
