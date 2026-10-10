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
//      the person creates it; the server verifies the presentation (it must spend the token's own
//      mint) and (an admin's name) approves; this is the only presentation;
//   3. the first sign-in: a holder-key signature in Hodos's sign prompt, signed by the issuer key,
//      so the page moves the account to a holder key of its own (silently, under the grant) and
//      signs in again with it;
//   4. the keep-alive: a silent holder signature, no prompt shown;
//   4b. a signed write: a message sent from the composer is signed silently by the holder key,
//      stored only once the server verified it;
//   4c. a prompted change: giving another person a role; the wallet refuses to sign it silently and
//      signs it only behind its prompt, which shows the change as text;
//   4d. a rotation: the account moves to a new holder key; a signature by the old key is refused;
//   4e. a recovery: the wallet's key no longer matches the server's (a lost key), the sign-in fails
//      with "Lost your signing key?", and the identity's issuer key rebinds the account in Hodos's
//      prompt; signing in works again;
//   5. refusals: a made-up presentation at registration, and a signature by no holder key.
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
/** Rows from the throwaway database, as objects. */
async function rows (sql) {
  const j = await (await fetch(`http://127.0.0.1:${RQLITE_PORT}/db/query?q=${encodeURIComponent(sql)}`)).json()
  const r = j.results[0]
  if (r.error) throw new Error(r.error)
  return (r.values ?? []).map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]])))
}
const identityRow = async (issuer) => (await rows(`SELECT holder_pubkey, seq FROM identities WHERE issuer = '${issuer}'`))[0]

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
  execFileSync('go', ['build', '-o', join(ROOT, 'p2p/boltverifyd/boltverifyd.exe'), '.'], { cwd: join(ROOT, 'p2p/boltverifyd'), stdio: 'inherit' }) // its own Go module
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
  set('register-name', ${JSON.stringify(ADMIN)}) // a name only: the form has no link fields (2026-10-10)
  document.getElementById('register-form').requestSubmit(); return true`)
const registerPrompt = await until('Hodos\'s identity prompt to register', async () => {
  const t = await promptText().catch(() => '')
  return /Create an account on app\.lab/.test(t) && /A new identity for this site/.test(t) ? t : null
})
await capture(prompt, join(OUT, '1-register-prompt.png')).catch(() => {})
assert.match(registerPrompt, /with an AuthBOLT identity/)
step('Hodos showed its own prompt: "Create an account on app.lab", offering a new identity for this site')
await clickPrompt('Create account')

// ---- 3. the first sign-in: a holder signature, then off the issuer key -----------------------------------
// Hodos's sign prompt (not the identity prompt): "Sign in on app.lab … with your AuthBOLT identity".
const signPrompt = async (title) => {
  const t = await promptText().catch(() => '')
  return t.includes(`${title} on app.lab`) && /with your AuthBOLT identity/.test(t) ? t : null
}
await until('the sign-in prompt after registering', () => signPrompt('Sign in'), 120000)
await capture(prompt, join(OUT, '2-signin-prompt.png')).catch(() => {})
step('registered: the server verified the presentation (its chain, Arcade for the anchor, the token\'s own mint) and approved the admin; now Hodos asks to sign in with a holder signature')
await clickPrompt('Sign')

// That signature was by the issuer key (no holder key yet), so the page rotated silently and asks again.
const me0 = await until('the identity to be recorded', async () => (await rows(`SELECT identity FROM users WHERE name = '${ADMIN}'`))[0]?.identity || null)
const moved = await until('the account to move off the issuer key', async () => {
  const r = await identityRow(me0)
  return r && r.holder_pubkey !== me0 ? r : null
})
assert.ok(moved.seq >= 1, `rotation seq ${moved.seq}`)
step(`first sign-in was by the issuer key, so the page moved the account to a holder key of its own without a prompt (seq ${moved.seq}, holder ${moved.holder_pubkey.slice(0, 12)}…)`)
await until('the sign-in prompt with the new key', () => signPrompt('Sign in'))
await clickPrompt('Sign')
await until('the workspace', async () => (await screen()) === 'workspace', 60000)
const me = await inPage('return (await fetch("/api/me")).json()')
assert.equal(me.name, ADMIN)
assert.equal(me.identity, me0)
assert.match(me.identity, /^0[23][0-9a-f]{64}$/)
await capture(isPage, join(OUT, '3-workspace.png')).catch(() => {})
step(`signed in as ${me.name} with the holder key, identity ${me.identity.slice(0, 12)}…`)

// The page's own client code, run in the page: the API client and the signer it uses for every change.
const CLIENT = `
  const { ApiClient } = await import('/lib/api.js')
  const { Signer } = await import('/lib/signer.js')
  const auth = await import('/lib/authbolt.js')
  const api = new ApiClient()
  const meNow = await api.me().catch(() => null)
  if (meNow) api.signer = new Signer({ bolt: window.BOLT, appKey: meNow.signing?.appKey ?? '', sid: meNow.signing?.sid ?? '' })
`

// ---- 4. keep-alive: a silent holder signature ---------------------------------------------------------
const refreshed = await inPage(`${CLIENT}
  const ch = await api.challenge('refresh')
  const s = await window.BOLT.sign({ kind: 'refresh', appPubKey: ch.appKey, payload: ch.data, silent: true })
  return { me: await api.refresh(ch.id, s.identity, s.signature), holder: s.holder }`)
assert.equal(refreshed.me.identity, me.identity)
assert.equal(refreshed.holder, moved.holder_pubkey, 'the keep-alive is signed by the holder key')
assert.equal(await signPrompt('Stay signed in'), null, 'no prompt was shown for the keep-alive')
step('keep-alive: a silent holder signature renewed the session (the person chose "keep me signed in"), no prompt shown')

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
assert.equal(proof.issuer, me.identity, 'the write belongs to the account\'s identity')
assert.equal(proof.holder, moved.holder_pubkey, 'and is signed by its holder key')
assert.equal(signedWrite.kind, 'message.post')
assert.equal(signedWrite.body.text, text)
assert.equal(signedWrite.target, 'POST /api/channels/1/messages')
assert.equal(await signPrompt('Approve a change'), null, 'no prompt was shown for the write')
await capture(isPage, join(OUT, '4b-signed-message.png')).catch(() => {})
step(`a message from the composer was signed silently by the holder key and stored once the server verified it (holder ${proof.holder.slice(0, 12)}…)`)

// ---- 4c. a prompted change: another person's role --------------------------------------------------------
// The other person is a row in this throwaway database: only the admin's signature is under test.
const [{ org_id: org }] = await rows(`SELECT org_id FROM users WHERE name = '${ADMIN}'`)
const OTHER = `member-${RUN}`
await fetch(`http://127.0.0.1:${RQLITE_PORT}/db/execute`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify([[`INSERT INTO users (org_id, name, name_key, role) VALUES (?, ?, ?, 'member')`, org, OTHER, OTHER]]),
})
const [{ id: otherId }] = await rows(`SELECT id FROM users WHERE name = '${OTHER}'`)
const silentTry = await inPage(`${CLIENT}
  const write = JSON.stringify({ v: 1, kind: 'user.role', target: 'PATCH /api/admin/users/${otherId}', body: { role: 'moderator' }, at: Date.now(), seq: Date.now(), sid: meNow.signing.sid })
  try { await window.BOLT.sign({ kind: 'write', appPubKey: meNow.signing.appKey, payload: write, silent: true }); return 'signed' } catch (e) { return e.message }`)
assert.match(silentTry, /NEEDS_PROMPT/, `a role change must not be signed silently (got: ${silentTry})`)
const roleChange = inPage(`${CLIENT} return api.setUserRole(${otherId}, 'moderator')`)
const rolePrompt = await until('the prompt for the role change', () => signPrompt('Approve a change'))
assert.match(rolePrompt, /user\.role/)
assert.match(rolePrompt, /PATCH \/api\/admin\/users\//)
assert.match(rolePrompt, /moderator/)
await capture(prompt, join(OUT, '4c-role-prompt.png')).catch(() => {})
await clickPrompt('Sign this change')
assert.equal((await roleChange).role, 'moderator')
assert.equal((await rows(`SELECT role FROM users WHERE id = ${otherId}`))[0].role, 'moderator')
step('a role change: the wallet refused to sign it silently (NEEDS_PROMPT), showed it as text ("user.role … moderator"), signed it once approved; the server applied it')

// ---- 4d. a rotation: the old holder key stops working -------------------------------------------------
const rotation = await inPage(`${CLIENT}
  const ch = await api.challenge('signin')
  const old = await window.BOLT.sign({ kind: 'signin', appPubKey: ch.appKey, payload: ch.data, silent: true })
  const r = await window.BOLT.sign({ kind: 'rotate', appPubKey: meNow.signing.appKey, payload: '', silent: true })
  await api.rotate(r.newHolder, r.seq, r.signature)
  await window.BOLT.sign({ kind: 'confirm', appPubKey: meNow.signing.appKey, payload: '', silent: true })
  let stale
  try { await api.signIn(ch.id, old.identity, old.signature); stale = 'accepted' } catch (e) { stale = e.code }
  const ch2 = await api.challenge('signin')
  const s = await window.BOLT.sign({ kind: 'signin', appPubKey: ch2.appKey, payload: ch2.data, silent: true })
  const after = await api.signIn(ch2.id, s.identity, s.signature)
  return { oldHolder: old.holder, newHolder: r.newHolder, stale, identity: after.identity }`)
assert.equal(rotation.oldHolder, moved.holder_pubkey)
assert.notEqual(rotation.newHolder, rotation.oldHolder)
assert.equal(rotation.stale, 'bad_signature', 'a sign-in signed by the old holder key is refused')
assert.equal(rotation.identity, me.identity)
const rotated = await identityRow(me.identity)
assert.equal(rotated.holder_pubkey, rotation.newHolder)
assert.ok(rotated.seq > moved.seq)
step(`rotation: the account moved to holder ${rotation.newHolder.slice(0, 12)}… (seq ${rotated.seq}); a sign-in signed by the old key was refused (bad_signature); the new key signs in`)

// ---- 4e. a recovery: the wallet's key is not the server's any more ----------------------------------
// The wallet switches to a key the server never heard of (a rotation it never posted), as if the
// holder key the server knows were lost.
await inPage(`${CLIENT}
  await window.BOLT.sign({ kind: 'rotate', appPubKey: meNow.signing.appKey, payload: '', silent: true })
  await window.BOLT.sign({ kind: 'confirm', appPubKey: meNow.signing.appKey, payload: '', silent: true })
  return true`)
await inPage('await fetch("/api/auth/logout", { method: "POST" }); location.reload(); return true').catch(() => {})
await until('the homepage after signing out', async () => (await screen()) === 'welcome')
await evaluate(isPage, 'document.getElementById("welcome-signin").click(); true')
await until('the sign-in button', async () => evaluate(isPage, '!document.getElementById("signin-submit").disabled'))
await evaluate(isPage, 'document.getElementById("signin-submit").click(); true')
await until('the sign-in prompt', () => signPrompt('Sign in'))
await clickPrompt('Sign')
await until('"Lost your signing key?"', async () => evaluate(isPage, '!document.getElementById("signin-recover").hidden'))
await capture(isPage, join(OUT, '4e-lost-key.png')).catch(() => {})
step('with a holder key the server does not know, the sign-in is refused and the page offers "Lost your signing key?"')
await evaluate(isPage, 'document.getElementById("signin-recover").click(); true')
const recoverPrompt = await until('the recovery prompt', () => signPrompt('Recover your account'))
assert.match(recoverPrompt, /every session there ends/)
await capture(prompt, join(OUT, '4e-recover-prompt.png')).catch(() => {})
await clickPrompt('Recover')
await until('the sign-in prompt after recovering', () => signPrompt('Sign in'))
await clickPrompt('Sign')
await until('the workspace after recovering', async () => (await screen()) === 'workspace', 60000)
assert.equal((await inPage('return (await fetch("/api/me")).json()')).identity, me.identity)
const recovered = await identityRow(me.identity)
assert.notEqual(recovered.holder_pubkey, rotation.newHolder)
assert.ok(recovered.seq > rotated.seq)
step(`recovery: the issuer key rebound the account to holder ${recovered.holder_pubkey.slice(0, 12)}… (seq ${recovered.seq}) behind Hodos's prompt; signed in again, same identity, no password anywhere`)

// ---- 5. refusals ------------------------------------------------------------------------------------
const refusals = await inPage(`${CLIENT}
  const code = async (fn) => { try { await fn(); return 'accepted' } catch (e) { return { status: e.status, code: e.code, message: e.message } } }
  const reg = await api.challenge('register', { name: 'forger-${RUN}' })
  const forged = await code(() => api.register(reg.id, ['0100beef00', '0100beef01']))
  const ch = await api.challenge('signin')
  const noKey = await code(() => api.signIn(ch.id, ${JSON.stringify(me.identity)}, '3006020101020101'))
  return { forged, noKey }`)
assert.equal(refusals.forged.status, 401, JSON.stringify(refusals.forged))
assert.equal(refusals.forged.code, 'not_verified')
assert.equal(refusals.noKey.code, 'bad_signature', JSON.stringify(refusals.noKey))
step(`a made-up presentation is refused at registration (${refusals.forged.message.slice(0, 70)}); a signature by no holder key is refused`)

console.log(`\nPASS AuthBOLT registration, holder-key sign-in, auto-rotation, keep-alive, silent and prompted writes, rotation and recovery on PeerLoop in Hodos (screenshots and logs in ${OUT})`)
stopAll()
process.exit(0)
