// Live: PeerLoop registration and sign-in with an AuthBOLT, in the real Hodos browser, on chain.
//
// Everything is real except the names: Hodos in spv mode on the regtest stack (its own verified
// header chain, Arcade only), p2pd with its own verified header chain synced from Arcade's
// chaintracks, which asks boltverifyd to check presentations (the Go port of b017: roots judged by
// p2pd's chain, Arcade asked only whether an anchor was seen; VERIFIER=sidecar uses the Node sidecar),
// fundd (the app's funding wallet: it pays for every move of an identity token), and the person's
// clicks in Hodos's own prompts. PeerLoop is served over https as app.lab, a made-up name the browser
// maps to this machine (so window.BOLT is injected and no real site is involved).
// Design: docs/authbolt-onchain-holder-keys.md.
//
// Negative controls, each must make it FAIL at registration: NC_NO_VERIFIER=1 (nothing p2pd is shown
// can be checked) and NC_NO_FUND=1 (p2pd has no funding wallet, so the token cannot move).
//
// What it shows, in order:
//   1. the page has window.BOLT with requestPresentation and no present; an AuthBOLT cannot be
//      minted from the page;
//   2. registering: the person fills the form, Hodos's prompt offers a new identity for this site and
//      says the site pays; the wallet mints it and moves the token on chain from its mint to holder key
//      1 (a commit and a settle, each paid by a coin from fundd that the page fetched); the server
//      verifies the move (seen by Arcade, out of the token's own mint) and approves the admin;
//   3. the first sign-in: a holder-key signature in Hodos's sign prompt, which binds holder key 1;
//   4. the keep-alive: a silent holder signature, no prompt shown;
//   4b. a signed write: a message sent from the composer is signed silently by the holder key,
//      stored only once the server verified it;
//   4c. a prompted change: giving another person a role; the wallet refuses to sign it silently and
//      signs it only behind its prompt, which shows the change as text;
//   4d. a rotation the server asks for once it is due: the token moves on chain to holder key 2
//      (silently under the grant, the app pays); a sign-in by the old key is refused;
//   4e. a recovery: the server's record names a holder this wallet does not hold (as if someone had
//      taken the token), the wallet refuses to sign for it, the sign-in fails with "Lost your signing
//      key?", and the identity's issuer key reissues the token (a new mint, moved to holder key 3, the
//      app pays) behind Hodos's prompt; signing in works again;
//   4f. out of step: the wallet moves the token to holder 4 but the page never posts it; signing in
//      (one click) is refused, the server names the holder it expects (3), and the wallet derives that
//      key and signs again silently; a write afterwards is signed by holder 3 too;
//   5. refusals: a made-up presentation at registration, and a signature by no holder key.
//
// Before running: the stack up (spv-testnet/stack), Hodos started with
//   tests/cross-wallet/start-hodos.ps1 -BrowserArgs '--host-resolver-rules="MAP app.lab 127.0.0.1"','--ignore-certificate-errors'
// and funded (node tests/hodos-spv/fund.mjs; the wallet pays for minting identities), p2pd built
// (cd p2p && go build -o results/p2pd.exe ./cmd/p2pd). Ports 8443, 8097, 8098 and 8099 must be free
// (stop the demo first).
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
import { ARCADE, MerklePath, Utils, arcadeStatus, mineUntilMined, spendCoinbase } from '../hodos-spv/lib.mjs'
import { Beef, Script } from '../hodos-spv/node_modules/@bsv/sdk/dist/esm/mod.js'

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
const FUND_SECRET = randomBytes(24).toString('hex')
const FUNDD = '127.0.0.1:8098'
const ROTATE_AFTER_S = 60 // p2pd asks for a rotation this long after a move
const APP_KEY = PrivateKey.fromRandom().toPublicKey().toString()
// Who checks presentations for p2pd: boltverifyd (default) or the bolt-verify sidecar (VERIFIER=sidecar).
const SIDECAR = process.env.VERIFIER === 'sidecar'
// Negative control (NC_NO_VERIFIER=1): nothing p2pd is shown can be checked, so the run must FAIL at
// registration. The verifier can reach neither Arcade (is the anchor seen?) nor p2pd's header chain
// (so no merkle path proves anything). A pass with this set would mean the test does not depend on
// the presentations being verified.
const NC = !!process.env.NC_NO_VERIFIER
// Negative control (NC_NO_FUND=1): p2pd runs without a funding wallet, so the wallet gets no coins
// for the commit and the settle and the token cannot move: the run must FAIL at registration. A pass
// would mean registration does not depend on the app paying for an on-chain move.
const NC_FUND = !!process.env.NC_NO_FUND
const NOWHERE = 'http://127.0.0.1:1'
const TAG = NC ? '-nc-verifier' : NC_FUND ? '-nc-fund' : '' // each negative control keeps its own logs
const SEEN = ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'ACCEPTED_BY_NETWORK', 'MINED']

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
  const log = createWriteStream(join(OUT, `${name}${TAG}.log`))
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

// ---- the pieces: rqlite (throwaway), fundd, p2pd over https (and the sidecar with VERIFIER=sidecar) ----
const cert = join(OUT, 'app.pem')
const key = join(OUT, 'app-key.pem')
if (!existsSync(cert)) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-keyout', key, '-out', cert,
    '-subj', `/CN=${NAME}`, '-addext', `subjectAltName=DNS:${NAME}`], { stdio: 'ignore' })
}
const secretFile = join(OUT, 'bolt-secret')
writeFileSync(secretFile, SECRET + '\n')
const fundSecretFile = join(OUT, 'fund-secret')
writeFileSync(fundSecretFile, FUND_SECRET + '\n')

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
const identityRow = async (issuer) =>
  (await rows(`SELECT holder_pubkey, holder_pkh, seq, outpoint, moved_at FROM identities WHERE issuer = '${issuer}'`))[0]
/** The transaction of a token outpoint (`txid.vout`), once Arcade has seen it. */
const seenOnChain = (outpoint) => until(`Arcade to have seen ${outpoint}`, async () => {
  const s = (await arcadeStatus(outpoint.split('.')[0])).txStatus
  return SEEN.includes(s) ? s : null
}, 30000, 500)

// fundd: its own key and coin stock (fresh each run), seeded with a mined deposit from a coinbase.
const FUND_DIR = join(OUT, 'fundd')
rmSync(FUND_DIR, { recursive: true, force: true })
mkdirSync(FUND_DIR, { recursive: true })
execFileSync('go', ['build', '-o', join(FUND_DIR, 'fundd.exe'), '.'], { cwd: join(ROOT, 'p2p/fundd'), stdio: 'inherit' })
start('fundd', join(FUND_DIR, 'fundd.exe'), ['-addr', FUNDD, '-secret-file', fundSecretFile, '-key-file', join(FUND_DIR, 'fundd.key'),
  '-state', join(FUND_DIR, 'state.json'), '-arcade-url', ARCADE])
const fundd = async (method, path, body) => {
  const r = await fetch(`http://${FUNDD}${path}`, { method, headers: { authorization: `Bearer ${FUND_SECRET}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  return r.json()
}
await until('fundd', async () => (await fetch(`http://${FUNDD}/healthz`)).ok)
{
  const { lockingScript } = await fundd('GET', '/address')
  const deposit = await spendCoinbase([{ lockingScript: Script.fromHex(lockingScript), satoshis: 100_000 }])
  deposit.merklePath = MerklePath.fromHex((await mineUntilMined(deposit.id('hex'))).merklePath)
  const beef = new Beef()
  beef.mergeTransaction(deposit.inputs[0].sourceTransaction) // its parent, so fundd can send it in Extended Format
  beef.mergeTransaction(deposit)
  const added = await fundd('POST', '/deposit', { beef: Utils.toHex(beef.toBinaryAtomic(deposit.id('hex'))) })
  assert.equal(added.added, 100_000, JSON.stringify(added))
}
const fundBalance = async () => (await fundd('GET', '/address')).balance
step(`fundd, the app's funding wallet, holds ${await fundBalance()} sat`)

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
  '-rotate-after', `${ROTATE_AFTER_S}s`,
  ...(NC_FUND ? [] : ['-fund-url', `http://${FUNDD}`, '-fund-secret-file', fundSecretFile]),
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

// ---- 2. register: a new identity for this site, moved on chain to holder key 1, the app paying ---------
const fundBefore = await fundBalance()
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
assert.match(registerPrompt, /app\.lab:8443 pays the network fees/)
step('Hodos showed its own prompt: "Create an account on app.lab", offering a new identity for this site, the site paying')
await clickPrompt('Create account')

// ---- 3. the first sign-in: holder key 1 signs, and the server binds it -------------------------------------
// Hodos's sign prompt (not the identity prompt): "Sign in on app.lab … with your AuthBOLT identity".
const signPrompt = async (title) => {
  const t = await promptText().catch(() => '')
  return t.includes(`${title} on app.lab`) && /with your AuthBOLT identity/.test(t) ? t : null
}
await until('the sign-in prompt after registering', () => signPrompt('Sign in'), 180000).catch(async (e) => {
  console.log(`the prompt says:\n${await promptText().catch(() => '(no prompt)')}`) // what the person would read
  throw e
})
await capture(prompt, join(OUT, '2-signin-prompt.png')).catch(() => {})
const me0 = await until('the identity to be recorded', async () => (await rows(`SELECT identity FROM users WHERE name = '${ADMIN}'`))[0]?.identity || null)
const registered = await identityRow(me0)
assert.equal(registered.seq, 1, 'registration moves the token to holder 1')
assert.match(registered.holder_pkh, /^[0-9a-f]{40}$/)
assert.match(registered.outpoint, /^[0-9a-f]{64}\.\d+$/)
const regSeen = await seenOnChain(registered.outpoint)
const fundAfterRegister = await fundBalance()
assert.ok(fundAfterRegister < fundBefore, `fundd paid for the move (${fundBefore} → ${fundAfterRegister})`)
step(`registered on chain: the token moved from its mint to holder 1 (settle ${registered.outpoint.slice(0, 12)}…, ${regSeen}), paid by fundd (${fundBefore - fundAfterRegister} sat with its splits); the server verified it and approved the admin`)
await clickPrompt('Sign')
await until('the workspace', async () => (await screen()) === 'workspace', 60000)
const me = await inPage('return (await fetch("/api/me")).json()')
assert.equal(me.name, ADMIN)
assert.equal(me.identity, me0)
assert.match(me.identity, /^0[23][0-9a-f]{64}$/)
const bound = await identityRow(me0)
assert.match(bound.holder_pubkey, /^0[23][0-9a-f]{64}$/, 'the first signature binds the holder key')
assert.notEqual(bound.holder_pubkey, me0, 'the holder key is not the issuer key')
// After the sign-in succeeded the page told the wallet the account name (BOLT.label); the wallet keeps
// it on this identity's link to this app here (read from the wallet's own token table, as Hodos itself).
const keptName = await until('the wallet to keep the account name', async () => {
  const { rows } = await (await fetch('http://127.0.0.1:31401/boltTokens', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'list', status: 'held', type: 'AuthBOLT' }),
  })).json()
  for (const r of rows ?? []) {
    const a = typeof r.attributes === 'string' ? JSON.parse(r.attributes) : r.attributes
    const link = a?.wallet?.apps?.find((x) => x.domain === `${NAME}:${PORT}` && x.appPubKey === APP_KEY)
    if (r.issuer === me0 && link?.label) return link.label
  }
  return null
}, 20000)
assert.equal(keptName, ADMIN)
step(`the wallet keeps the name the app accepted, "${keptName}", on this identity's link (told after the sign-in succeeded)`)
await capture(isPage, join(OUT, '3-workspace.png')).catch(() => {})
step(`signed in as ${me.name}: holder key 1 (${bound.holder_pubkey.slice(0, 12)}…, whose hash the settle pays) signed and is now bound; identity ${me.identity.slice(0, 12)}…`)

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
  return { me: await api.refresh(ch.id, s.identity, s.signature, s.holder), holder: s.holder }`)
assert.equal(refreshed.me.identity, me.identity)
assert.equal(refreshed.holder, bound.holder_pubkey, 'the keep-alive is signed by the holder key')
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
assert.equal(proof.holder, bound.holder_pubkey, 'and is signed by its holder key')
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
assert.ok(rolePrompt.includes(`As ${ADMIN}`), 'the prompt names the account, not only a key')
await capture(prompt, join(OUT, '4c-role-prompt.png')).catch(() => {})
await clickPrompt('Sign this change')
assert.equal((await roleChange).role, 'moderator')
assert.equal((await rows(`SELECT role FROM users WHERE id = ${otherId}`))[0].role, 'moderator')
step('a role change: the wallet refused to sign it silently (NEEDS_PROMPT), showed it as text ("user.role … moderator"), signed it once approved; the server applied it')

// ---- 4d. a rotation the server asks for: the token moves on chain, the old holder key stops working ----
const due = bound.moved_at + ROTATE_AFTER_S * 1000 - Date.now()
if (due > 0) {
  console.log(`     (waiting ${Math.ceil(due / 1000)} s until p2pd asks for a rotation)`)
  await sleep(due + 1000)
}
const fundBeforeRotate = await fundBalance()
const rotation = await inPage(`${CLIENT}
  const ch = await api.challenge('signin')
  const old = await window.BOLT.sign({ kind: 'signin', appPubKey: ch.appKey, payload: ch.data, silent: true })
  // The page's own keep-alive step: the server's answer asks for a rotation, which the page has the
  // wallet make (silently, the app paying) and posts, then signs in again.
  const after = await auth.authenticate({ api, bolt: window.BOLT, purpose: 'refresh' })
  let stale
  try { await api.signIn(ch.id, old.identity, old.signature, old.holder); stale = 'accepted' } catch (e) { stale = e.code }
  return { oldHolder: old.holder, stale, identity: after.identity }`)
assert.equal(rotation.oldHolder, bound.holder_pubkey)
assert.equal(rotation.stale, 'bad_signature', 'a sign-in signed by the old holder key is refused')
assert.equal(rotation.identity, me.identity)
const rotated = await identityRow(me.identity)
assert.equal(rotated.seq, 2, 'the rotation moved the token to holder 2')
assert.notEqual(rotated.holder_pkh, bound.holder_pkh)
assert.notEqual(rotated.outpoint, bound.outpoint)
assert.match(rotated.holder_pubkey, /^0[23][0-9a-f]{64}$/, 'the sign-in after the rotation bound holder key 2')
assert.notEqual(rotated.holder_pubkey, bound.holder_pubkey)
const rotSeen = await seenOnChain(rotated.outpoint)
assert.ok(await fundBalance() < fundBeforeRotate, 'fundd paid for the rotation')
assert.equal(await signPrompt('Change your signing key'), null, 'no prompt was shown for the rotation (keep me signed in)')
step(`rotation: once due, the server asked for it and the token moved on chain to holder 2 (settle ${rotated.outpoint.slice(0, 12)}…, ${rotSeen}) silently, fundd paying; a sign-in by the old key was refused (bad_signature); holder key 2 signs in`)

// ---- 4e. a recovery: the server's record names a holder this wallet does not hold ---------------------
// Declared residue (this throwaway database only): the server's holder (its hash and bound key) is
// replaced by a key nobody holds, as if someone else had taken the token. The wallet's token is still at
// holder 2, so the wallet cannot sign for the holder the server names, and the token is dead to the app.
const nobodyKey = PrivateKey.fromRandom().toPublicKey()
const nobody = nobodyKey.toString()
const nobodyHash = Utils.toHex(nobodyKey.toHash())
await fetch(`http://127.0.0.1:${RQLITE_PORT}/db/execute`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify([[`UPDATE identities SET holder_pubkey = ?, holder_pkh = ? WHERE issuer = ?`, nobody, nobodyHash, me.identity]]),
})
await inPage('await fetch("/api/auth/logout", { method: "POST" }); location.reload(); return true').catch(() => {})
await until('the homepage after signing out', async () => (await screen()) === 'welcome')
await evaluate(isPage, 'document.getElementById("welcome-signin").click(); true')
await until('the sign-in button', async () => evaluate(isPage, '!document.getElementById("signin-submit").disabled'))
await evaluate(isPage, 'document.getElementById("signin-submit").click(); true')
await until('the sign-in prompt', () => signPrompt('Sign in'))
await clickPrompt('Sign')
await until('"Lost your signing key?"', async () => evaluate(isPage, '!document.getElementById("signin-recover").hidden'))
await capture(isPage, join(OUT, '4e-lost-key.png')).catch(() => {})
step('the server names a holder the wallet does not hold: the wallet refuses to sign for it, and the page offers "Lost your signing key?"')
const fundBeforeRecover = await fundBalance()
await evaluate(isPage, 'document.getElementById("signin-recover").click(); true')
const recoverPrompt = await until('the recovery prompt', () => signPrompt('Recover your account'))
assert.match(recoverPrompt, /makes a new identity token/)
assert.match(recoverPrompt, /pays the network fees/)
await capture(prompt, join(OUT, '4e-recover-prompt.png')).catch(() => {})
await clickPrompt('Recover')
await until('the sign-in prompt after recovering', () => signPrompt('Sign in'), 180000)
await clickPrompt('Sign')
await until('the workspace after recovering', async () => (await screen()) === 'workspace', 60000)
assert.equal((await inPage('return (await fetch("/api/me")).json()')).identity, me.identity)
const recovered = await identityRow(me.identity)
assert.equal(recovered.seq, 3, 'the reissue moved the new token to holder 3')
assert.notEqual(recovered.outpoint, rotated.outpoint)
assert.notEqual(recovered.holder_pubkey, nobody)
assert.notEqual(recovered.holder_pubkey, rotated.holder_pubkey)
const recSeen = await seenOnChain(recovered.outpoint)
assert.ok(await fundBalance() < fundBeforeRecover, 'fundd paid for the reissue\'s move')
step(`recovery: the issuer key minted a new token for the same identity and moved it to holder 3 (settle ${recovered.outpoint.slice(0, 12)}…, ${recSeen}) behind Hodos's prompt, fundd paying the move; signed in again, same identity, no password anywhere`)

// ---- 4f. out of step: the wallet moved further than the server knows -------------------------------------
// The server asks for a rotation once it is due; the wallet moves the token to holder 4 (on chain, the
// app paying) but the page never posts the move, as if it had closed in between. The server still
// records holder 3.
const due2 = recovered.moved_at + ROTATE_AFTER_S * 1000 - Date.now()
if (due2 > 0) {
  console.log(`     (waiting ${Math.ceil(due2 / 1000)} s until p2pd asks for a rotation)`)
  await sleep(due2 + 1000)
}
const unposted = await inPage(`${CLIENT}
  const ch = await api.challenge('refresh')
  const s = await window.BOLT.sign({ kind: 'refresh', appPubKey: ch.appKey, payload: ch.data, silent: true })
  const answer = await api.refresh(ch.id, s.identity, s.signature, s.holder)
  if (!answer.rotate) return { asked: false }
  const moved = await window.BOLT.sign({ kind: 'rotate', appPubKey: ch.appKey, payload: answer.rotate.data, silent: true,
    fund: (req) => api.fund(answer.rotate.id, req) })
  return { asked: true, moved: Array.isArray(moved.package) }`)
assert.deepEqual(unposted, { asked: true, moved: true }, 'the wallet moved the token without the page posting it')
assert.equal((await identityRow(me.identity)).seq, 3, 'the server still records holder 3')
await inPage('await fetch("/api/auth/logout", { method: "POST" }); location.reload(); return true').catch(() => {})
await until('the homepage after signing out', async () => (await screen()) === 'welcome')
await evaluate(isPage, 'document.getElementById("welcome-signin").click(); true')
await until('the sign-in button', async () => evaluate(isPage, '!document.getElementById("signin-submit").disabled'))
await evaluate(isPage, 'document.getElementById("signin-submit").click(); true')
await until('the sign-in prompt', () => signPrompt('Sign in'))
await clickPrompt('Sign') // the wallet signs with holder 4; the server names holder 3; the retry is silent
await until('the workspace, with no second prompt', async () => (await screen()) === 'workspace', 60000)
const inStep = await identityRow(me.identity)
assert.equal(inStep.seq, 3)
assert.equal(inStep.holder_pubkey, recovered.holder_pubkey, 'signed in with holder 3, the key the server holds')
const text2 = `signed again ${RUN}`
await inPage(`
  document.querySelector('#channel-list [data-channel="1"]').click()
  await new Promise((r) => setTimeout(r, 300))
  document.getElementById('channel-input').value = ${JSON.stringify(text2)}
  document.getElementById('channel-form').requestSubmit()
  return true`)
const sent2 = await until('the message after the retry to be signed and stored', async () => {
  const page = await inPage('return (await fetch("/api/channels/1/messages?limit=20")).json()')
  return page.messages?.find((m) => m.text === text2 && m.signed)
})
const proof2 = await inPage(`return (await fetch('/api/messages/${sent2.id}/proof')).json()`)
assert.equal(proof2.holder, recovered.holder_pubkey, 'the wallet keeps signing with holder 3 for this app')
step('out of step: the wallet had moved to holder 4 unposted; the sign-in was refused, the server named holder 3, and the wallet derived that key and signed again silently (one click); a message afterwards is signed by holder 3 too')

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

console.log(`\nPASS AuthBOLT on chain: registration, holder-key sign-in, keep-alive, silent and prompted writes, rotation, recovery and an out-of-step sign-in on PeerLoop in Hodos, the app paying every move (screenshots and logs in ${OUT})`)
stopAll()
process.exit(0)
