// Cross-wallet e2e: the Hodos browser and bsv-browser (Android emulator) pay each other.
//
// Both wallets are in spv mode against the local Arcade (spv-testnet stack). Each browser shows
// page/index.html; this script drives the two wallets through those pages (server.mjs), funds
// one of them (chosen at random) from a regtest coinbase, and relays a BRC-29 payment each way,
// the second paid out of the first:
//
//   sender:   getPublicKey(counterparty = receiver's identity key) -> createAction (broadcast via Arcade)
//   relay:    Atomic BEEF + sender identity key + derivation prefix/suffix
//   receiver: internalizeAction('wallet payment'), verified against its own header chain
//
// Each payment is unmined when received, then mined by hand and proven by both wallets.
//
//   node run.mjs            (both pages must be open; see docs/cross-wallet-e2e.md)
//
// Env: HODOS_ROLE / BSV_ROLE (page roles, default hodos / bsv), PACE_MS (pause between visible
// steps, default 500), FUNDED (hodos | bsv: which wallet is funded, default random), plus WALLET_URL, ARCADE_URL, RPC_URL as in ../hodos-spv/lib.mjs.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import {
  MerklePath, P2PKH, PrivateKey, PublicKey, Utils,
  arcadeStatus, mineUntilMined, sleep, spendCoinbase, until
} from '../hodos-spv/lib.mjs'
import { startRelay } from './server.mjs'
import { adb, dismissToast, openUrl, reloadTab, screenshot, watchToast } from './emulator.mjs'
import { approveDomain, autoApprove, capture, evaluate, hasTab, openTab } from './hodos.mjs'

const { Beef } = createRequire(new URL('../hodos-spv/', import.meta.url))('@bsv/sdk')

const HODOS = process.env.HODOS_ROLE ?? 'hodos'
const BSV = process.env.BSV_ROLE ?? 'bsv'
const WALLET = process.env.WALLET_URL ?? 'http://127.0.0.1:31401'
// Arcade's chaintracks pushes each new header on this stream; the pages show the pushes (page/index.html).
const TIP_STREAM = process.env.TIP_STREAM_URL ?? 'http://localhost:8083/chaintracks/v2/tip/stream'
const pageUrl = role => `http://localhost:${relay.port}/?role=${role}&tip=${encodeURIComponent(TIP_STREAM)}`
const PACE = Number(process.env.PACE_MS ?? 500)
const FUND = 200_000
const PAY = 30_000
// The wallet paid first has nothing else to spend (on a new wallet), so it sends less back: the
// difference covers its mining fee and, from Hodos, the wallet's service fee.
const PAY_BACK = 15_000
const RUN = `xw-${Date.now().toString(36)}`
// Diagnostic only: carry on past bsv-browser's proof check. The run then ends INCOMPLETE, never PASS.
const SKIP_BSV_PROOF = process.env.SKIP_BSV_PROOF === '1'
const skipped = []
const OUT = fileURLToPath(new URL('./out/', import.meta.url))
let stopApproving = () => []
let stopToasts = () => {}
// Mining for a tx the network has seen: a short pause, then a block every few seconds until it is in one.
const MINE = { settle: 1000, wait: 6000, every: 500, tries: 20 }
const T0 = Date.now()
const at = () => `[${String(Math.round((Date.now() - T0) / 1000)).padStart(3)}s]`
const BRC29 = [2, '3241645161d8']
const SEEN = ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES']

// Throws rather than exits (lib.mjs's ok exits), so the miner is restored and the pages show the failure.
const ok = (cond, msg) => { if (!cond) throw new Error(msg); console.log(`${at()}    ok  ${msg}`) }

const relay = await startRelay()
const call = (role, method, args, opts) => relay.call(role, method, args, opts)
// The test's own bookkeeping (what a wallet holds, how far its chain is, whether a payment is
// proven) is asked without a line on the page: the page lists what the test does to the wallet.
const ask = (role, method, args) => relay.call(role, method, args, { quiet: true })
// `text` goes to the console. A page is told only what concerns its own wallet, in its own terms:
// `pages` maps a role to the line its page shows, and a role that is not in it is told nothing.
const say = async (text, kind = 'step', pages = {}) => {
  console.log(kind === 'step' ? `\n${at()} == ${text}` : `${at()}    ${text}`)
  for (const [role, line] of Object.entries(pages)) relay.note(role, line, kind)
  await sleep(PACE)
}
const each = line => ({ [HODOS]: line, [BSV]: line })
const short = hex => `${String(hex).slice(0, 16)}…`
const fails = async (label, p) => { try { await p } catch (e) { return ok(true, `${label}: refused (${String(e.message).slice(0, 80)})`) } ok(false, `${label}: was accepted`) }
const rnd = () => Utils.toBase64(Utils.toArray(Math.random().toString(36).slice(2, 10), 'utf8'))
const p2pkh = pubKeyHex => new P2PKH().lock(PublicKey.fromString(pubKeyHex).toHash())

// What each wallet holds. Neither wallet lets a page list its default basket. Hodos's total is
// read from the wallet process. bsv-browser has no outside API, so its figure is the net of this
// run's actions as the wallet itself reports them to the page (every action here carries the run
// label); the app's own wallet screen shows the same total.
const balance = {
  [HODOS]: async () => (await (await fetch(WALLET + '/wallet/balance')).json()).balance,
  [BSV]: async () => (await ask(BSV, 'listActions', { labels: [RUN], limit: 100 })).actions.reduce((s, a) => s + a.satoshis, 0)
}
const heightOf = async role => (await ask(role, 'getHeight', {})).height
// Hodos syncs its header chain every 30 s; bsv-browser on each new-header poll of its monitor (10 s in spv mode).
const waitForHeader = (role, height) =>
  until(`${role} header chain reaches ${height}`, async () => (await heightOf(role).catch(() => 0)) >= height, { timeout: 180000, every: 1500 })
const actionStatus = async (role, txid) =>
  (await ask(role, 'listActions', { labels: [RUN], limit: 100 })).actions.find(a => a.txid === txid)?.status

function tamperBump (atomic, txid) {
  const beef = Beef.fromBinary(atomic)
  for (const bump of beef.bumps) {
    for (const level of bump.path) {
      const sib = level.find(l => l.hash && !l.txid)
      if (sib) { sib.hash = 'ab'.repeat(32); return beef.toBinaryAtomic(txid) }
    }
  }
  // No sibling hash to change (e.g. the proven ancestor's only neighbour is a duplicate marker):
  // claim the proof belongs to the block before, whose merkle root it cannot match.
  if (beef.bumps.length) { beef.bumps[0].blockHeight -= 1; return beef.toBinaryAtomic(txid) }
  throw new Error(`the BEEF carries no proof to tamper with: ${beef.txs.map(t => `${t.txid.slice(0, 8)}${t.bumpIndex === undefined ? '' : '+bump'}`).join(' ')}`)
}

const internalizeArgs = (tx, remittance, description) => ({
  tx,
  outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: remittance }],
  description,
  labels: [RUN]
})

/** Fund `role` from its own mined coinbase spend, handed to the wallet through its page. */
async function fund (role, id) {
  await say(`Funding ${role} with ${FUND} sats from a regtest coinbase`, 'step', { [role]: `Receiving ${FUND} sats from a regtest coinbase` })
  const sender = PrivateKey.fromRandom()
  const prefix = rnd(); const suffix = rnd()
  const child = PublicKey.fromString(id).deriveChild(sender, `2-${BRC29[1]}-${prefix} ${suffix}`)
  const before = await balance[role]()
  const tx = await spendCoinbase([{ lockingScript: new P2PKH().lock(child.toHash()), satoshis: FUND }])
  const st = await mineUntilMined(tx.id('hex'), MINE)
  tx.merklePath = MerklePath.fromHex(st.merklePath)
  await waitForHeader(role, st.blockHeight)
  await call(role, 'internalizeAction', internalizeArgs(tx.toAtomicBEEF(),
    { senderIdentityKey: sender.toPublicKey().toString(), derivationPrefix: prefix, derivationSuffix: suffix }, 'cross-wallet funding'))
  ok((await balance[role]()) - before === FUND, `${role} balance rose by ${FUND}`)
  const line = `funded: ${short(tx.id('hex'))} in block ${st.blockHeight}`
  await say(`${role} ${line}`, 'ok', { [role]: `Funded: ${short(tx.id('hex'))} in block ${st.blockHeight}, proof verified against this wallet's headers` })
  return st.blockHeight
}

/** `from` pays `to` `amount` sats; returns the block the payment was mined in. `proofHeight` is the highest block a BUMP in the BEEF can refer to. */
async function pay (from, to, ids, proofHeight, amount) {
  await say(`${from} pays ${to} ${amount} sats (BRC-29, relayed as an Atomic BEEF)`, 'step', { [from]: `Paying ${amount} sats to ${short(ids[to])} (BRC-29)` })
  const derivationPrefix = rnd(); const derivationSuffix = rnd()
  // The key the payment is locked to. Hodos derives it itself, as the BRC-29 sender. bsv-browser
  // keeps the BRC-29 protocol for its own pay screens and refuses it to a page, so there the payee's
  // key is derived with a one-off sender key and bsv-browser simply pays the resulting script
  // (a payment request): still a BRC-29 output for the payee, with the one-off key as its sender.
  let senderIdentityKey = ids[from]
  let publicKey
  if (from === BSV) {
    const oneOff = PrivateKey.fromRandom()
    senderIdentityKey = oneOff.toPublicKey().toString()
    publicKey = PublicKey.fromString(ids[to]).deriveChild(oneOff, `2-${BRC29[1]}-${derivationPrefix} ${derivationSuffix}`).toString()
  } else {
    publicKey = (await call(from, 'getPublicKey', { protocolID: BRC29, keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: ids[to] })).publicKey
  }
  const sent = await call(from, 'createAction', {
    description: `cross-wallet: ${from} pays ${to}`,
    labels: [RUN],
    outputs: [{ satoshis: amount, lockingScript: p2pkh(publicKey).toHex(), outputDescription: 'BRC-29 payment' }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  ok(sent.txid && Array.isArray(sent.tx), `${from} built and broadcast ${short(sent.txid)}`)
  relay.note(from, `Sent ${short(sent.txid)}, broadcast through Arcade`, 'ok')
  await until('Arcade has seen the payment', async () => SEEN.includes((await arcadeStatus(sent.txid)).txStatus ?? ''), { timeout: 30000, every: 500 })
  ok((await arcadeStatus(sent.txid)).txStatus !== 'MINED', 'the payment is on the network and not mined')
  await waitForHeader(to, proofHeight)

  const remittance = { senderIdentityKey, derivationPrefix, derivationSuffix }
  relay.note(to, `Receiving ${amount} sats, unmined (${short(sent.txid)}); first a tampered proof and a wrong derivation, which must be refused`, 'step')
  const before = await balance[to]()
  await fails(`${to}, tampered proof`, call(to, 'internalizeAction', internalizeArgs(tamperBump(sent.tx, sent.txid), remittance, 'cross-wallet: tampered')))
  await fails(`${to}, wrong derivation`, call(to, 'internalizeAction', internalizeArgs(sent.tx, { ...remittance, derivationSuffix: rnd() }, 'cross-wallet: wrong derivation')))
  ok((await balance[to]()) === before, `${to} balance unchanged by the refused payments`)

  await call(to, 'internalizeAction', internalizeArgs(sent.tx, remittance, `cross-wallet: from ${from}`))
  ok((await balance[to]()) - before === amount, `${to} balance rose by ${amount} while the payment is unmined`)
  await say(`${to} accepted the unmined payment from ${from}`, 'ok', { [to]: 'Refused both bad copies, accepted the unmined payment' })

  const st = await mineUntilMined(sent.txid, MINE)
  await say(`Mined in block ${st.blockHeight}; each wallet now proves it against its own headers`, 'step', each(`${short(sent.txid)} mined in block ${st.blockHeight}; proving it against this wallet's headers`))
  await Promise.all([from, to].map(async role => {
    await waitForHeader(role, st.blockHeight)
    if (role === BSV && SKIP_BSV_PROOF) { skipped.push(`${role} proof of ${sent.txid.slice(0, 16)}…`); await say(`SKIPPED: ${role} proof check (SKIP_BSV_PROOF)`, 'fail', { [role]: 'SKIPPED: proof check (SKIP_BSV_PROOF)' }); return }
    await until(`${role} shows the payment completed`, async () => (await actionStatus(role, sent.txid)) === 'completed', { timeout: 300000, every: 1500 })
    ok(true, `${role} holds a verified proof for ${short(sent.txid)}`)
    relay.note(role, `Proof verified for ${short(sent.txid)}`, 'ok')
  }))
  if (SKIP_BSV_PROOF) await say(`${from} → ${to} proven by hodos; bsv not checked`, 'fail')
  else await say(`${from} → ${to} proven by both wallets`, 'ok')
  return st.blockHeight
}

const minerRunning = () => execFileSync('docker', ['ps', '--filter', 'name=cb-block-generator', '--format', '{{.Names}}']).toString().includes('cb-block-generator')
const minerWasRunning = minerRunning()
let failed = false
try {
  console.log(`run label ${RUN}\nopen  http://localhost:${relay.port}/?role=${HODOS}  in Hodos and, after  adb reverse tcp:${relay.port} tcp:${relay.port} , http://localhost:${relay.port}/?role=${BSV}  in bsv-browser`)
  // Put the page in front of each wallet: a Hodos tab (opened through DevTools, or reloaded if it is
  // already there) and a tab in the emulator app (the relay port forwarded, so the page is `localhost`
  // there too: the app refuses wallet calls from a page served from an IP address).
  if (process.env.HODOS_AUTO_APPROVE !== 'off') {
    const url = pageUrl(HODOS)
    if (await hasTab(url)) await evaluate(url, 'location.reload(); true')
    else await openTab(url)
  }
  if (process.env.BSV_ADB !== 'off') {
    // The emulator reaches the relay and the header stream on its own localhost.
    for (const port of [relay.port, new URL(TIP_STREAM).port]) adb('reverse', `tcp:${port}`, `tcp:${port}`)
    openUrl(pageUrl(BSV))
  }
  let lastReload = Date.now()
  await until('both pages connected', async () => {
    if (relay.connected(HODOS) && relay.connected(BSV)) return true
    // The app can show a tab that failed to load while the relay was down; reload it.
    if (!relay.connected(BSV) && process.env.BSV_ADB !== 'off' && Date.now() - lastReload > 10000) { lastReload = Date.now(); await reloadTab().catch(() => {}) }
    return false
  }, { timeout: 600000, every: 1000 })
  if (minerWasRunning) execFileSync('docker', ['stop', 'cb-block-generator'], { stdio: 'ignore' })
  // bsv-browser shows an error toast over its page in spv mode (no exchange rate); keep it closed.
  if (process.env.BSV_ADB !== 'off') stopToasts = watchToast()

  // Hodos: approve the page's domain once (the connect dialog's effect), then answer any modal it
  // still raises, e.g. a payment asked for because no BSV price is available.
  if (process.env.HODOS_AUTO_APPROVE !== 'off') {
    await approveDomain(`localhost:${relay.port}`)
    stopApproving = autoApprove({ onApprove: r => console.log(`   hodos modal approved: [${r.button}] ${r.what}`) })
  }
  await say('Both browsers connected; reading identity keys (spv mode, local Arcade)', 'step', each('Connected to the test; reading this wallet’s identity key (spv mode, local Arcade)'))
  const ids = {
    [HODOS]: (await call(HODOS, 'getPublicKey', { identityKey: true })).publicKey,
    [BSV]: (await call(BSV, 'getPublicKey', { identityKey: true })).publicKey
  }
  ok(ids[HODOS] && ids[BSV] && ids[HODOS] !== ids[BSV], 'two distinct wallets')

  // One wallet is funded from the chain, chosen at random (FUNDED=hodos|bsv fixes it); it pays the
  // other, which pays part of that back out of the payment it has just proven.
  const first = [HODOS, BSV].includes(process.env.FUNDED) ? process.env.FUNDED : (Math.random() < 0.5 ? HODOS : BSV)
  const second = first === HODOS ? BSV : HODOS
  let proofHeight = await fund(first, ids[first])
  proofHeight = Math.max(proofHeight, await pay(first, second, ids, proofHeight, PAY))
  await pay(second, first, ids, proofHeight, PAY_BACK)

  if (skipped.length) throw new Error(`INCOMPLETE, not checked: ${skipped.join('; ')}`)
  await say(`PASS: ${first} funded, paid ${second}, was paid back, and both wallets proved both payments`, 'ok', each('PASS: paid, was paid, and proved both payments'))
  console.log('\nPASS cross-wallet')
} catch (e) {
  failed = true
  console.error('\nFAIL', e)
  // A page is told why only when the failure names its own wallet (or neither).
  for (const [r, other] of [[HODOS, BSV], [BSV, HODOS]]) {
    const mine = String(e.message).includes(r) || !String(e.message).includes(other)
    relay.note(r, mine ? `FAIL: ${e.message}` : 'FAIL: the test stopped', 'fail')
  }
  await sleep(1000)
} finally {
  if (minerWasRunning) execFileSync('docker', ['start', 'cb-block-generator'], { stdio: 'ignore' })
  // What each browser showed at the end, kept inside the repo (out/ is gitignored).
  try {
    mkdirSync(OUT, { recursive: true })
    stopToasts()
    if (process.env.BSV_ADB !== 'off' && dismissToast()) await sleep(2500)
    if (process.env.HODOS_AUTO_APPROVE !== 'off') await capture(pageUrl(HODOS), `${OUT}${RUN}-hodos.png`)
    if (process.env.BSV_ADB !== 'off') screenshot(`${OUT}${RUN}-bsv.png`)
    console.log(`screenshots: ${OUT}${RUN}-hodos.png, ${OUT}${RUN}-bsv.png`)
  } catch (e) { console.log(`no screenshots: ${e.message}`) }
  const approved = stopApproving()
  if (approved.length) console.log(`hodos modals approved automatically: ${approved.length}`)
  await relay.close()
}
process.exit(failed ? 1 : 0)
