// Spend from a funded Hodos wallet in spv mode and follow the transaction to a proof the wallet
// has verified against its own header chain.
//
//   1. POST /transaction/send (wallet builds the BEEF, broadcasts through Arcade)
//   2. mine; the wallet's TaskCheckForProofs picks up the BUMP from Arcade
//   3. require the wallet to mark the tx confirmed (it refuses a proof it cannot verify)
//
//   node send.mjs [sats]
import { PrivateKey } from '@bsv/sdk'

const WALLET = process.env.WALLET_URL ?? 'http://127.0.0.1:31401'
const ARCADE = process.env.ARCADE_URL ?? 'http://localhost:8080'
const RPC_URL = process.env.RPC_URL ?? 'http://localhost:29292'
const SATS = Number(process.argv[2] ?? 50_000)
const MINER_WIF = process.env.MINER_WIF ?? 'L56TgyTpDdvL3W24SMoALYotibToSCySQeo4pThLKxw6EFR6f93Q'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1) } console.log('ok  ', m) }
async function rpc (method, params = []) {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('bitcoin:bitcoin').toString('base64') }, body: JSON.stringify({ method, params }) })
  const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result
}
async function until (label, fn, { timeout = 60000, every = 1000 } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(every) }
  throw new Error('timeout: ' + label)
}

const to = PrivateKey.fromWif(MINER_WIF).toAddress() // any valid address; the harness's own key
const bal0 = (await (await fetch(WALLET + '/wallet/balance')).json()).balance
console.log('balance:', bal0)

const res = await fetch(WALLET + '/transaction/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toAddress: to, amount: SATS }) })
const out = await res.json().catch(() => ({}))
console.log('send ->', res.status, JSON.stringify(out).slice(0, 300))
ok(res.status === 200 && out.success !== false, `wallet built and broadcast the spend${out.error ? ': ' + out.error : ''}`)
const txid = out.txid ?? out.txId
ok(txid, `txid ${String(txid).slice(0, 12)}…`)

const seen = await until('Arcade knows the tx', async () => { const s = await (await fetch(`${ARCADE}/tx/${txid}`)).json(); return s.txStatus ? s : null }, { timeout: 30000 })
console.log('Arcade status:', seen.txStatus)
await sleep(3000)
for (let i = 0; i < 5; i++) {
  await rpc('generate', [1]).catch(() => {})
  const s = await (await fetch(`${ARCADE}/tx/${txid}`)).json()
  if (s.txStatus === 'MINED') { console.log('mined at', s.blockHeight); break }
  await sleep(3000)
}
// The wallet's proof task runs every 60 s and refuses a proof until its header chain has the block
// (header sync runs every 30 s), so allow a few ticks.
const confirmed = await until('wallet marks the tx completed', async () => {
  const j = await (await fetch(WALLET + '/wallet/activity')).json()
  const a = (j.items ?? []).find(x => x.txid === txid)
  return a && a.status === 'completed' ? a : null
}, { timeout: 200000, every: 5000 })
ok(confirmed, `wallet shows ${txid.slice(0, 12)}… as ${confirmed.status}`)
console.log('PASS spend + verified proof')
