// Fund a Hodos wallet running in HODOS_CHAIN_MODE=spv, using only what a real sender has:
// Arcade (submit + BUMP) and the wallet's own HTTP API. Teranode RPC is used ONLY to mine
// and to find a coinbase to spend (the harness plays the role of the chain's miner).
//
//   1. spend a mature coinbase into a BRC-29 output derived for the wallet's identity key
//   2. submit it to Arcade, mine, take the BUMP Arcade returns
//   3. wrap tx + BUMP as Atomic BEEF and call the wallet's /internalizeAction
//
// Before the real call it sends a copy whose BUMP has been tampered with and requires the
// wallet to reject it (ERR_PROOF_NOT_VERIFIED): the header-chain check must be doing work.
//
//   node fund.mjs            (wallet must be running with spv env; see ../../docs/hodos-spv.md)
import { PrivateKey, PublicKey, P2PKH, Transaction, MerklePath, Utils } from '@bsv/sdk'
import { spendCoinbase } from './lib.mjs'

const WALLET = process.env.WALLET_URL ?? 'http://127.0.0.1:31401'
const ARCADE = process.env.ARCADE_URL ?? 'http://localhost:8080'
const RPC_URL = process.env.RPC_URL ?? 'http://localhost:29292'
const AMOUNT = Number(process.env.FUND_SATS ?? 1_000_000)
// Public regtest key from Teranode's settings.conf (PK1): the node's coinbase pays this key.
const MINER_WIF = process.env.MINER_WIF ?? 'L56TgyTpDdvL3W24SMoALYotibToSCySQeo4pThLKxw6EFR6f93Q'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1) } console.log('ok  ', m) }

async function rpc (method, params = []) {
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('bitcoin:bitcoin').toString('base64') },
    body: JSON.stringify({ method, params })
  })
  const j = await r.json()
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`)
  return j.result
}
async function wallet (path, body) {
  const r = await fetch(WALLET + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: r.status, json }
}
async function until (label, fn, { timeout = 60000, every = 1000 } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(every) }
  throw new Error('timeout: ' + label)
}

// ---- wallet identity ------------------------------------------------------------------
const idRes = await wallet('/getPublicKey', { identityKey: true })
ok(idRes.status === 200 && idRes.json.publicKey, `wallet identity key ${idRes.json.publicKey?.slice(0, 12)}…`)
const walletPub = PublicKey.fromString(idRes.json.publicKey)

// ---- BRC-29 payment output derived for the wallet --------------------------------------
const senderPriv = PrivateKey.fromRandom()
const prefix = Utils.toBase64(Utils.toArray(Math.random().toString(36).slice(2, 10), 'utf8'))
const suffix = Utils.toBase64(Utils.toArray(Math.random().toString(36).slice(2, 10), 'utf8'))
const invoice = `2-3241645161d8-${prefix} ${suffix}` // exactly as Hodos derives it
const childPub = walletPub.deriveChild(senderPriv, invoice)
const payScript = new P2PKH().lock(childPub.toHash())

// ---- spend a mature coinbase (the shared helper retries until the network, not just Arcade, takes one) ----
const tx = await spendCoinbase([{ lockingScript: payScript, satoshis: AMOUNT }])
const txid = tx.id('hex')
ok(true, `Arcade accepted funding tx ${txid.slice(0, 12)}…`)

// ---- mine, then take the BUMP from Arcade ----------------------------------------------
await until('SEEN_ON_NETWORK', async () => ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'MINED'].includes((await (await fetch(`${ARCADE}/tx/${txid}`)).json()).txStatus), { timeout: 30000 })
await sleep(3000)
let st
for (let i = 0; i < 6 && !st; i++) {
  await rpc('generate', [1]).catch(() => {})
  st = await until('MINED', async () => { const s = await (await fetch(`${ARCADE}/tx/${txid}`)).json(); return s.txStatus === 'MINED' && s.merklePath ? s : null }, { timeout: 30000, every: 2000 }).catch(() => null)
}
ok(st?.merklePath, `Arcade returned a BUMP at height ${st?.blockHeight}`)
const mp = MerklePath.fromHex(st.merklePath)

// ---- Atomic BEEF = tx + its BUMP --------------------------------------------------------
tx.merklePath = mp
const goodBeef = tx.toAtomicBEEF()

// Tampered copy: corrupt one sibling hash in the BUMP so its root no longer matches the chain.
const bad = Transaction.fromHex(tx.toHex())
const badMp = MerklePath.fromHex(st.merklePath)
// Corrupt the first sibling hash anywhere in the path (the tx can be last in an odd-sized block, whose
// level-0 sibling is a hash-less duplicate).
let sib
for (const level of badMp.path) { sib = level.find(l => !l.txid && l.hash); if (sib) break }
if (sib) sib.hash = 'ab'.repeat(32)
bad.merklePath = badMp
const badBeef = bad.toAtomicBEEF()

// ---- wait until the wallet's own verified chain has that height --------------------------
await until(`wallet header chain reaches ${mp.blockHeight}`, async () => (await wallet('/getHeaderForHeight', { height: mp.blockHeight })).status === 200, { timeout: 120000, every: 2000 })
ok(true, `wallet has a verified header at height ${mp.blockHeight}`)

const body = beef => ({
  tx: beef,
  outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { senderIdentityKey: senderPriv.toPublicKey().toString(), derivationPrefix: prefix, derivationSuffix: suffix } }],
  description: 'spv funding'
})

if (sib) {
  const r = await wallet('/internalizeAction', body(badBeef))
  ok(r.status === 400 && r.json.code === 'ERR_PROOF_NOT_VERIFIED', `tampered BUMP rejected by the wallet (${r.status} ${r.json.code})`)
} else {
  console.log('  (BUMP has no sibling hash to tamper with; skipping negative check)')
}

const before = await (await fetch(WALLET + '/wallet/balance')).json()
const r = await wallet('/internalizeAction', body(goodBeef))
ok(r.status === 200, `internalizeAction accepted funding BEEF (${r.status} ${JSON.stringify(r.json).slice(0, 120)})`)
// The wallet's balance cache (60 s TTL) is not invalidated by internalizeAction, so poll.
const after = await until('balance to reflect the funding', async () => {
  const b = await (await fetch(WALLET + '/wallet/balance')).json()
  return b.balance !== before.balance ? b : null
}, { timeout: 90000, every: 3000 })
console.log('balance before:', before.balance, 'after:', after.balance)
ok(after.balance - before.balance === AMOUNT, `wallet balance rose by exactly ${AMOUNT} sats`)
console.log(JSON.stringify({ txid, height: mp.blockHeight, sats: AMOUNT, senderIdentityKey: senderPriv.toPublicKey().toString() }))
console.log('PASS fund by BEEF')
