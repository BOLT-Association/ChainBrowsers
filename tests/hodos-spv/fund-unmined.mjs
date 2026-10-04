// Fund the wallet with a BEEF whose SUBJECT tx is not mined yet, then follow it to spendable.
//
//   tx A  spends a coinbase to the harness key, is mined          -> proven parent (BUMP from Arcade)
//   tx B  spends A and pays the wallet, accepted by Arcade, NOT mined
//   BEEF  = B + A(with BUMP)  -> /internalizeAction
//
// Expected behaviour in spv mode:
//   - internalize succeeds and the balance rises, but the output is NOT spendable yet
//     (nothing has proven B), so a spend of the same size fails
//   - after B is mined, the wallet's proof task fetches the BUMP from Arcade, verifies it
//     against the wallet's own header chain, stores it and PROMOTES the output
//   - the same spend then succeeds
//
// Start the wallet with HODOS_ZERO_CONF=off: this script times the PROOF path, and with zero-conf on
// the output is spendable before any proof (see zero-conf.mjs).
// The stack's block generator would mine tx B within seconds, so stop it first and restart it after:
//   docker stop cb-block-generator
//   node fund-unmined.mjs
//   docker start cb-block-generator
import { wallet, ok, sleep, until, rpc, minerKey, minerScript, P2PKH, Transaction, MerklePath,
  spendCoinbase, submit, mineUntilMined, paymentOutputFor, waitForWalletHeader, balance, WALLET } from './lib.mjs'

const FUND = 2_000_000
const SPEND = 1_500_000 // larger than anything already spendable, so only the new output can cover it

const wBefore = await balance()
const pay = await paymentOutputFor(FUND)

// tx A: coinbase -> 2 outputs to the harness key; mined; gives B a proven parent.
const A = await spendCoinbase([{ lockingScript: minerScript, satoshis: FUND + 50_000 }])
const aStatus = await mineUntilMined(A.id('hex'))
A.merklePath = MerklePath.fromHex(aStatus.merklePath)
ok(true, `parent tx A ${A.id('hex').slice(0, 12)}… mined at ${aStatus.blockHeight}`)

// tx B: spends A:0, pays the wallet; accepted by Arcade but not mined.
const B = new Transaction()
B.addInput({ sourceTransaction: A, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(minerKey) })
B.addOutput(pay.output)
B.addOutput({ lockingScript: minerScript, satoshis: 50_000 })
await B.sign()
const bTxid = B.id('hex')
ok(await submit(B), `Arcade accepted unmined subject tx B ${bTxid.slice(0, 12)}…`)
await until('B on network', async () => ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES'].includes((await (await fetch(`${process.env.ARCADE_URL ?? 'http://localhost:8080'}/tx/${bTxid}`)).json()).txStatus), { timeout: 30000 })

await waitForWalletHeader(aStatus.blockHeight)
const beef = B.toAtomicBEEF()
const r = await wallet('/internalizeAction', pay.internalizeBody(beef))
ok(r.status === 200, `internalizeAction accepted BEEF with an unmined subject (${r.status} ${JSON.stringify(r.json).slice(0, 100)})`)

const wAfter = await until('balance to reflect B', async () => { const b = await balance(); return b !== wBefore ? b : null }, { timeout: 90000, every: 3000 })
ok(wAfter - wBefore === FUND, `balance rose by ${FUND} (counts the output)`)

// Not spendable yet: no proof for B exists.
const earlySend = await fetch(WALLET + '/transaction/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toAddress: minerKey.toAddress(), amount: SPEND }) })
const early = await earlySend.json().catch(() => ({}))
ok(early.success === false, `output is not spendable while its tx is unmined (${String(early.error).slice(0, 90)})`)

// Mine B; the wallet's proof task should verify the BUMP and promote the output.
const bMined = await mineUntilMined(bTxid)
console.log('B mined at', bMined.blockHeight, '- waiting for the wallet to verify the proof and promote the output')
await waitForWalletHeader(bMined.blockHeight)
const spent = await until('spend succeeds once the output is promoted', async () => {
  const res = await fetch(WALLET + '/transaction/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ toAddress: minerKey.toAddress(), amount: SPEND }) })
  const j = await res.json().catch(() => ({}))
  return j.success ? j : null
}, { timeout: 240000, every: 10000 })
ok(spent.txid, `spend of ${SPEND} sats succeeded after promotion (${spent.txid.slice(0, 12)}…)`)
console.log('PASS unmined-subject funding promoted on verified proof')
