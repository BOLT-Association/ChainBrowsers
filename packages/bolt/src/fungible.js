// Fungible tokens (SimpleMultiBOLT), driven through b017's stateful token class with a wallet Signer.
//
// Unlike the NFT family (built template-by-template in nft.js), the fungible commit/settle logic —
// ancestor reconstruction, proof vouts, 16-byte balance arithmetic — lives in b017's SimpleMultiBOLT
// class. Since b017 now takes a Signer, the wallet can drive that class without ever holding the key.
//
// A held token is reconstructed from its stored BEEF: the class needs the tail of the lineage (the
// settle the token rests on, the commit before it, and the settle/mint that anchors them), which the
// package always carries. The grandparent a next settle rebuilds is that commit, present in the package.
import { Hash } from '@bsv/sdk'
import { SimpleMultiBOLT, recognizeType } from 'b017'

/** Decimal string -> 16-byte little-endian balance (128-bit, wrapping). */
export const amountToLE = (dec) => {
  let x = BigInt(dec) & ((1n << 128n) - 1n)
  const b = []
  for (let i = 0; i < 16; i++) { b.push(Number(x & 0xffn)); x >>= 8n }
  return b
}

/** Mint a fungible token: the signer's key becomes issuer and first owner; funded by `fund` ({tx,vout}
 *  whose output pays the signer's pubKeyHash). Returns the built (unbroadcast) SimpleMultiBOLT instance. */
export async function mintFungible ({ signer, fund, amount }) {
  const t = new SimpleMultiBOLT()
  await t.mint(signer, fund.tx, '', amountToLE(amount))
  return t
}

/** Rebuild a SimpleMultiBOLT instance from a held token's BEEF subject tx so it can be spent again.
 *  Walks input[0] back over the token lineage the package carries (ending at the settle/mint anchor). */
export function reconstructFungible (subjectTx, signer) {
  const lineage = []
  let tx = subjectTx
  while (tx && recognizeType(tx.outputs[0]?.lockingScript) === 'SimpleMultiBOLT') {
    lineage.push(tx)
    tx = tx.inputs[0]?.sourceTransaction
  }
  lineage.reverse() // [anchor(settle|mint), …, subject]

  const lock = subjectTx.outputs[0].lockingScript
  const t = new SimpleMultiBOLT()
  t.signer = signer
  t.tx = subjectTx
  t.voutIdx = 0
  t.prevTxs = lineage
  t.pubKey = signer.publicKey
  t.pubKeyHash = Hash.hash160(signer.publicKey)
  t.balance = lock.chunks[0].data
  t.balanceCommit = new Array(16).fill(0)
  t.issuerPubKey = lock.chunks[10].data
  return t
}

/** Transfer the whole fungible token to `toPubKey` (33-byte compressed). Self-funds from the token's
 *  change. Returns the built commit and settle (unbroadcast). */
export async function transferFungible (t, toPubKey) {
  await t.transfer(toPubKey)
  const n = t.prevTxs.length
  return { commit: t.prevTxs[n - 2], settle: t.prevTxs[n - 1] }
}
