// Shared helpers for the Hodos spv harness scripts.
import { PrivateKey, PublicKey, P2PKH, Transaction, MerklePath, Utils } from '@bsv/sdk'

export { PrivateKey, PublicKey, P2PKH, Transaction, MerklePath, Utils }

export const WALLET = process.env.WALLET_URL ?? 'http://127.0.0.1:31401'
export const ARCADE = process.env.ARCADE_URL ?? 'http://localhost:8080'
export const RPC_URL = process.env.RPC_URL ?? 'http://localhost:29292'
// Public regtest key from Teranode's settings.conf (PK1): the node's coinbase pays this key.
export const MINER_WIF = process.env.MINER_WIF ?? 'L56TgyTpDdvL3W24SMoALYotibToSCySQeo4pThLKxw6EFR6f93Q'
export const minerKey = PrivateKey.fromWif(MINER_WIF)
export const minerScript = new P2PKH().lock(minerKey.toPublicKey().toHash())

export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const ok = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1) } console.log('ok  ', m) }

// Teranode RPC: used by the harness ONLY to mine and to find a coinbase. The wallet never calls it.
export async function rpc (method, params = []) {
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('bitcoin:bitcoin').toString('base64') },
    body: JSON.stringify({ method, params })
  })
  const j = await r.json()
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`)
  return j.result
}

export async function wallet (path, body) {
  const r = await fetch(WALLET + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: r.status, json }
}

export async function until (label, fn, { timeout = 60000, every = 1000 } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(every) }
  throw new Error('timeout: ' + label)
}

export const arcadeStatus = async txid => (await fetch(`${ARCADE}/tx/${txid}`)).json()

/** Submit a signed tx (with source txs attached) to Arcade as Extended Format. */
export async function submit (tx) {
  const res = await fetch(`${ARCADE}/tx`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: tx.toHexEF() })
  return res.status === 202
}

/** Spend a random mature coinbase (retrying until Arcade accepts one) into `outputs`; the
 *  remainder goes back to the miner key. `outputs` = [{ lockingScript, satoshis }]. */
export async function spendCoinbase (outputs) {
  const tip = (await rpc('getinfo')).blocks
  const total = outputs.reduce((a, o) => a + o.satoshis, 0)
  for (let k = 0; k < 40; k++) {
    const height = tip - 100 - Math.floor(Math.random() * 60)
    const block = await rpc('getblock', [await rpc('getblockhash', [height]), 1])
    const cbHex = await rpc('getrawtransaction', [block.tx?.[0] ?? block.merkleroot, 0])
    const source = Transaction.fromHex(cbHex)
    const vout = source.outputs.findIndex(o => o.lockingScript.toHex() === minerScript.toHex())
    if (vout < 0) continue
    const tx = new Transaction()
    tx.addInput({ sourceTransaction: source, sourceOutputIndex: vout, unlockingScriptTemplate: new P2PKH().unlock(minerKey) })
    for (const o of outputs) tx.addOutput(o)
    tx.addOutput({ lockingScript: minerScript, satoshis: source.outputs[vout].satoshis - total })
    await tx.sign()
    if (await submit(tx)) {
      // Accepted for processing is not accepted: a coinbase that an earlier run already spent
      // is rejected a moment later. Wait for the network to take it, else try another.
      const verdict = await until('network verdict', async () => {
        const st = (await arcadeStatus(tx.id('hex'))).txStatus
        return ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'MINED', 'REJECTED', 'DOUBLE_SPEND_ATTEMPTED'].includes(st) ? st : null
      }, { timeout: 20000, every: 500 }).catch(() => 'UNKNOWN')
      if (!['REJECTED', 'DOUBLE_SPEND_ATTEMPTED', 'UNKNOWN'].includes(verdict)) return tx
    }
    console.log(`  coinbase at ${height} not usable; trying another`)
  }
  throw new Error('no usable coinbase')
}

/** Mine until Arcade reports the tx MINED with a BUMP; returns Arcade's status object. */
export async function mineUntilMined (txid) {
  await until('SEEN_ON_NETWORK', async () => ['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'MINED'].includes((await arcadeStatus(txid)).txStatus), { timeout: 30000 })
  await sleep(3000)
  for (let i = 0; i < 6; i++) {
    await rpc('generate', [1]).catch(() => {})
    const st = await until('MINED', async () => { const s = await arcadeStatus(txid); return s.txStatus === 'MINED' && s.merklePath ? s : null }, { timeout: 30000, every: 2000 }).catch(() => null)
    if (st) return st
  }
  throw new Error('tx never mined')
}

/** BRC-29 payment output for the wallet's identity key. */
export async function paymentOutputFor (satoshis) {
  const id = await wallet('/getPublicKey', { identityKey: true })
  if (!id.json.publicKey) throw new Error('no wallet identity key: ' + JSON.stringify(id))
  const walletPub = PublicKey.fromString(id.json.publicKey)
  const senderPriv = PrivateKey.fromRandom()
  const rnd = () => Utils.toBase64(Utils.toArray(Math.random().toString(36).slice(2, 10), 'utf8'))
  const prefix = rnd(); const suffix = rnd()
  const childPub = walletPub.deriveChild(senderPriv, `2-3241645161d8-${prefix} ${suffix}`)
  return {
    output: { lockingScript: new P2PKH().lock(childPub.toHash()), satoshis },
    internalizeBody: beef => ({
      tx: beef,
      outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { senderIdentityKey: senderPriv.toPublicKey().toString(), derivationPrefix: prefix, derivationSuffix: suffix } }],
      description: 'spv funding (unmined subject)'
    })
  }
}

export async function waitForWalletHeader (height, timeout = 120000) {
  await until(`wallet header chain reaches ${height}`, async () => (await wallet('/getHeaderForHeight', { height })).status === 200, { timeout, every: 2000 })
}

export const balance = async () => (await (await fetch(WALLET + '/wallet/balance')).json()).balance
