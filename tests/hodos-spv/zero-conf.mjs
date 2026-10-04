// Zero-conf acceptance of a received output (spv mode, HODOS_ZERO_CONF on, the default).
//
//   Z1  A BEEF whose subject tx B is on the network but NOT mined: the output is spendable at once,
//       Arcade accepts a spend of it (a child of an unmined parent), and once a block is mined both
//       transactions get verified proofs and show `completed`.
//   Z2  A real double-spend of B: a conflicting tx C spends the same input as B. If Arcade flags B
//       as DOUBLE_SPEND_ATTEMPTED the wallet must withdraw the output (it stops being spendable).
//       (If Arcade's first-seen rule does not flag B, that is reported rather than faked.)
//
// Needs the stack's block generator stopped (`docker stop cb-block-generator`); the wallet is
// started WITHOUT HODOS_ZERO_CONF=off.   node zero-conf.mjs
import { wallet, ok, sleep, until, rpc, minerKey, minerScript, P2PKH, Transaction, MerklePath,
  spendCoinbase, submit, mineUntilMined, mineBlockWith, paymentOutputFor, waitForWalletHeader, balance,
  arcadeStatus, WALLET, ARCADE } from './lib.mjs'

const FUND = 3_000_000
const SPEND = 2_500_000
const send = async amount => {
  const res = await fetch(WALLET + '/transaction/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toAddress: minerKey.toAddress(), amount }) })
  const j = await res.json().catch(() => ({}))
  return j.success ? j : { error: j.error }
}
const activity = async () => (await (await fetch(WALLET + '/wallet/activity')).json()).items ?? []

/** Mine A, build B (pays the wallet, spends A:0), get B on the network unmined, internalize it. */
async function receiveUnmined (label) {
  const pay = await paymentOutputFor(FUND)
  const A = await spendCoinbase([{ lockingScript: minerScript, satoshis: FUND + 50_000 }])
  const aStatus = await mineUntilMined(A.id('hex'))
  A.merklePath = MerklePath.fromHex(aStatus.merklePath)
  const B = new Transaction()
  B.addInput({ sourceTransaction: A, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(minerKey) })
  B.addOutput(pay.output)
  B.addOutput({ lockingScript: minerScript, satoshis: 50_000 })
  await B.sign()
  const bTxid = B.id('hex')
  ok(await submit(B), `${label}: Arcade accepted B ${bTxid.slice(0, 12)}…`)
  await until('B seen', async () => ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES'].includes((await arcadeStatus(bTxid)).txStatus), { timeout: 30000 })
  await waitForWalletHeader(aStatus.blockHeight)
  const r = await wallet('/internalizeAction', pay.internalizeBody(B.toAtomicBEEF()))
  ok(r.status === 200, `${label}: internalized the BEEF with an unmined subject`)
  return { A, B, bTxid }
}

// ---------------------------------------------------------------- Z1
console.log('\n== Z1: spend a received output before any block')
const z1 = await receiveUnmined('Z1')
const t0 = Date.now()
const spend = await until('spendable at zero-conf', async () => { const s = await send(SPEND); return s.txid ? s : null }, { timeout: 30000, every: 500 })
ok(spend.txid, `output spendable ${((Date.now() - t0) / 1000).toFixed(1)}s after internalize, with no block mined (spend ${spend.txid.slice(0, 12)}…)`)
const seen = await until('Arcade has the child', async () => { const s = await arcadeStatus(spend.txid); return ['ACCEPTED_BY_NETWORK', 'SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'MINED'].includes(s.txStatus) ? s : null }, { timeout: 30000 })
ok(seen, `Arcade accepted a spend of an unmined parent (${seen.txStatus}; a child of an unmined tx may stay ACCEPTED_BY_NETWORK until a block)`)
await mineBlockWith(spend.txid)
const bothDone = await until('both proofs verified and stored', async () => {
  const items = await activity()
  const a = items.find(x => x.txid === z1.bTxid)?.status
  const b = items.find(x => x.txid === spend.txid)?.status
  return a === 'completed' && b === 'completed' ? [a, b] : null
}, { timeout: 240000, every: 5000 })
ok(bothDone, 'after the block: the received tx and the spend of it are both completed (verified proofs)')

// ---------------------------------------------------------------- Z2
console.log('\n== Z2: a conflicting spend of the same input')
const z2 = await receiveUnmined('Z2')
ok(!!(await until('spendable', async () => { const s = await send(1_000); return s.txid ? s : null }, { timeout: 30000, every: 500 })), 'Z2: received output is spendable before the conflict (a small test spend succeeded)')
// C spends the same input as B (A:0) to a different output: a classic double-spend of B.
const C = new Transaction()
C.addInput({ sourceTransaction: z2.A, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(minerKey) })
C.addOutput({ lockingScript: minerScript, satoshis: FUND + 40_000 })
await C.sign()
const cAccepted = await submit(C)
await sleep(4000)
const bNow = (await arcadeStatus(z2.bTxid)).txStatus
const cNow = (await arcadeStatus(C.id('hex'))).txStatus
console.log(`   Arcade: B=${bNow}  C(conflict)=${cNow}  (C submitted: ${cAccepted})`)
if (bNow === 'DOUBLE_SPEND_ATTEMPTED') {
  const withdrawn = await until('output withdrawn', async () => { const s = await send(SPEND); return s.txid ? null : s }, { timeout: 150000, every: 5000 })
  ok(withdrawn, 'Z2: Arcade flagged B as a double-spend and the wallet withdrew the output (spend now refused)')
} else {
  console.log(`   Arcade did not flag B (first-seen rule: C=${cNow}); the withdrawal path is covered by unit tests only`)
}
console.log('PASS zero-conf')
