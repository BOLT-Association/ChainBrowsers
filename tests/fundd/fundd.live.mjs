// Live: fundd, PeerLoop's funding wallet (p2p/fundd), on the regtest stack, through Arcade only.
//
//   1. fundd starts (its own key and stock, on loopback, a shared secret);
//   2. a deposit: a coinbase pays fundd's locking script; once mined, the deposit carries Arcade's merkle
//      path (a BEEF whole on its own) and is posted to /deposit;
//   3. a coin: fundd splits a coin of exactly 600 sat off its stock (a broadcast transaction) and signs it
//      SIGHASH_SINGLE | ANYONECANPAY | FORKID as input 1 of a transaction it did not build;
//   4. that transaction is finished elsewhere (input 0 is someone else's coin, signed afterwards) and
//      broadcast: Teranode accepting it shows fundd's signature is valid on the node, not only in go-sdk.
//
// Negative control: NC_TAMPER=1 must make it fail (see below).
//
// Before running: the stack up (spv-testnet/stack). Logs and fundd's state: tests/cross-wallet/out/fundd.
//   node tests/fundd/fundd.live.mjs
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  ARCADE, MerklePath, P2PKH, PrivateKey, Transaction, Utils, arcadeStatus, mineUntilMined, ok, spendCoinbase, submit, until
} from '../hodos-spv/lib.mjs'
import { Beef, Script, UnlockingScript } from '../hodos-spv/node_modules/@bsv/sdk/dist/esm/mod.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT = join(ROOT, 'tests/cross-wallet/out/fundd')
const ADDR = '127.0.0.1:8098'
const SECRET = randomBytes(24).toString('hex')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'secret'), SECRET + '\n')

execFileSync('go', ['build', '-o', join(OUT, 'fundd.exe'), '.'], { cwd: join(ROOT, 'p2p/fundd'), stdio: 'inherit' })
const log = createWriteStream(join(OUT, 'fundd.log'))
const fundd = spawn(join(OUT, 'fundd.exe'), ['-addr', ADDR, '-secret-file', join(OUT, 'secret'), '-key-file', join(OUT, 'fundd.key'),
  '-state', join(OUT, 'state.json'), '-arcade-url', ARCADE], { windowsHide: true })
fundd.stdout.pipe(log)
fundd.stderr.pipe(log)
process.on('exit', () => { try { fundd.kill() } catch {} })

const call = async (method, path, body) => {
  const r = await fetch(`http://${ADDR}${path}`, { method, headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
await until('fundd', async () => (await fetch(`http://${ADDR}/healthz`)).ok, { timeout: 20000, every: 300 })
const { body: address } = await call('GET', '/address')
const fundLock = Script.fromHex(address.lockingScript)
ok(address.balance === 0, `fundd is up with an empty stock, locking script ${address.lockingScript.slice(0, 20)}…`)

// 2. The deposit, once mined: its merkle path makes it whole for whoever spends from fundd, and its
// parent (the coinbase) goes with it, so fundd can put it in Extended Format (toAtomicBEEF stops at a
// proven transaction and would leave the parent out).
const deposit = await spendCoinbase([{ lockingScript: fundLock, satoshis: 100_000 }])
const mined = await mineUntilMined(deposit.id('hex'))
deposit.merklePath = MerklePath.fromHex(mined.merklePath)
const beef = new Beef()
beef.mergeTransaction(deposit.inputs[0].sourceTransaction)
beef.mergeTransaction(deposit)
const dep = await call('POST', '/deposit', { beef: Utils.toHex(beef.toBinaryAtomic(deposit.id('hex'))) })
ok(dep.status === 200 && dep.body.added === 100_000, `deposit: ${JSON.stringify(dep.body)}`)
const logged = await until("the deposit in fundd's log", async () => readFileSync(join(OUT, 'fundd.log'), 'utf8').match(new RegExp(`broadcast ${deposit.id('hex')} as ([a-z ]+)`))?.[1], { timeout: 5000, every: 200 })
ok(logged === 'extended format', `fundd sent the deposit as ${logged} (its parent came with it)`)

// 3. A transaction fundd did not build: input 0 is someone else's 3,000 sat; outputs 2,999 + 1 sat.
const someone = PrivateKey.fromRandom()
const theirs = await spendCoinbase([{ lockingScript: new P2PKH().lock(someone.toPublicKey().toHash()), satoshis: 3000 }])
const tx = new Transaction()
tx.version = 2
tx.addInput({ sourceTransaction: theirs, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(someone), sequence: 0xffffffff })
tx.addOutput({ lockingScript: new P2PKH().lock(someone.toPublicKey().toHash()), satoshis: 2999 })
tx.addOutput({ lockingScript: new P2PKH().lock(someone.toPublicKey().toHash()), satoshis: 1 })
// The draft as a wallet sends it: its own inputs not signed yet (empty unlocking scripts), outputs final.
const draft = new Transaction(tx.version, tx.inputs.map((i) => ({ ...i, unlockingScriptTemplate: undefined, unlockingScript: new UnlockingScript() })), tx.outputs, tx.lockTime)
const coin = await call('POST', '/coin', { amount: 600, tx: draft.toHex(), index: 1 })
ok(coin.status === 200, `coin: ${coin.status} ${JSON.stringify(coin.body).slice(0, 120)}`)
const split = Transaction.fromAtomicBEEF(Utils.toArray(coin.body.tx, 'hex'))
ok(split.outputs[coin.body.vout].satoshis === 600 && split.outputs[coin.body.vout].lockingScript.toHex() === address.lockingScript, 'the coin is exactly 600 sat to fundd')
const splitSeen = await until('the split seen', async () => {
  const s = (await arcadeStatus(split.id('hex'))).txStatus
  return ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'ACCEPTED_BY_NETWORK', 'MINED'].includes(s) ? s : null
}, { timeout: 30000, every: 500 })
ok(true, `fundd's split is on the network (${splitSeen})`)
const unlocking = UnlockingScript.fromHex(coin.body.unlockingScript)
const sig = unlocking.chunks[0].data
ok(sig[sig.length - 1] === 0xc3, 'signed SIGHASH_SINGLE | ANYONECANPAY | FORKID')

// 4. Finish it elsewhere: the coin as input 1, then input 0 signed over everything; broadcast.
tx.addInput({ sourceTransaction: split, sourceOutputIndex: coin.body.vout, unlockingScript: unlocking, sequence: 0xffffffff })
// Negative control (NC_TAMPER=1): change the output at the coin's index after fundd signed; the
// network must refuse the transaction, so the run FAILS.
if (process.env.NC_TAMPER) tx.outputs[1].satoshis = 2
await tx.sign()
ok(await submit(tx), 'Arcade took the finished transaction for processing')
const verdict = await until('a network verdict', async () => {
  const s = (await arcadeStatus(tx.id('hex'))).txStatus
  return ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'ACCEPTED_BY_NETWORK', 'MINED', 'REJECTED', 'DOUBLE_SPEND_ATTEMPTED'].includes(s) ? s : null
}, { timeout: 30000, every: 500 })
ok(!['REJECTED', 'DOUBLE_SPEND_ATTEMPTED'].includes(verdict), `Teranode accepted a transaction paid by fundd's coin (${verdict}): its SINGLE | ANYONECANPAY signature is valid on the node`)
const { body: after } = await call('GET', '/address')
ok(after.balance > 100_000 - 600 - 100 && after.balance < 100_000 - 600, `fundd's stock after one coin: ${after.balance} sat (the coin and the split's fee)`)
console.log(`\nPASS fundd funded a transaction on the regtest stack (logs and state in ${OUT})`)
process.exit(0)
