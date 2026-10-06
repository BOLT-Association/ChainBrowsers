// A no-network test harness shared by the handler/fungible suites: each wallet is the SDK's ProtoWallet
// (real BRC-100 keys + signatures) behind brc100Core, on a pretend chain that mines funding, serves
// headers, and runs a broadcaster that refuses what a node would (missing inputs, value creation, bad
// scripts) and executes every tx on the @bsv/sdk Spend engine.
import { MerklePath, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk'
import { verifyTx } from 'b017'
import { BoltHandler, brc100Core, memoryStore } from '../src/index.js'

export function pretendChain () {
  const headers = new Map() // height -> 80-byte header hex
  const seen = new Set()
  const txs = new Map() // txid -> Transaction, for a broadcaster that is handed hex (the wallet rail)
  const sent = []
  let height = 100
  /** A mined tx paying `script`: a one-tx block whose merkle root is the txid. */
  const mine = (script, satoshis) => {
    const tx = new Transaction(1, [], [{ satoshis, lockingScript: script }], ++height)
    const txid = tx.id('hex')
    tx.merklePath = new MerklePath(height, [[{ offset: 0, hash: txid, txid: true }]])
    const header = new Array(80).fill(0)
    header.splice(36, 32, ...Utils.toArray(txid, 'hex').reverse())
    headers.set(height, Utils.toHex(header))
    seen.add(txid)
    txs.set(txid, tx)
    return tx
  }
  const broadcast = async (tx) => {
    const txid = tx.id('hex')
    sent.push(txid)
    if (seen.has(txid)) return { status: 'already-seen' }
    let inSats = 0
    for (const input of tx.inputs) {
      const source = input.sourceTransaction
      if (!source || !seen.has(source.id('hex'))) return { status: 'rejected', detail: 'missing inputs' }
      inSats += source.outputs[input.sourceOutputIndex].satoshis
    }
    const outSats = tx.outputs.reduce((sum, o) => sum + o.satoshis, 0)
    if (outSats > inSats) return { status: 'rejected', detail: 'creates value' }
    try { if (!verifyTx(tx, true).valid) return { status: 'rejected', detail: 'script' } } catch (e) { return { status: 'rejected', detail: 'script' } }
    seen.add(txid)
    txs.set(txid, tx)
    return { status: 'accepted' }
  }
  return { headers, seen, sent, txs, mine, broadcast }
}

export function walletOn (chain, { store = memoryStore(), ...opts } = {}) {
  const proto = new ProtoWallet(PrivateKey.fromRandom())
  const calls = []
  const wallet = {
    getPublicKey: (args) => { calls.push('getPublicKey'); return proto.getPublicKey(args) },
    createSignature: (args) => { calls.push('createSignature'); return proto.createSignature(args) },
    getHeaderForHeight: async ({ height }) => { calls.push('getHeaderForHeight'); return { header: chain.headers.get(height) } },
    createAction: async ({ outputs }) => {
      calls.push('createAction')
      const tx = chain.mine(Script.fromHex(outputs[0].lockingScript), outputs[0].satoshis)
      return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
    }
  }
  const handler = new BoltHandler({ core: brc100Core({ wallet, broadcast: chain.broadcast, store }), ...opts })
  return { handler, calls, store }
}
