// Transaction builders for the NFT family (MinSimpleBOLT, AuthBOLT). The covenant fixes each layout:
//
//   mint    in  [funding]                       out [token, change]
//   commit  in  [token, funding?]               out [token, proof, change?]
//   settle  in  [token, proof?, funding?]       out [token, change?]
//
// A settle carries the proof input when the token it started from was itself a settle (it spends the
// proof output of the commit before that one, which paid the current owner). Unfunded spends have no
// funding input and no change; they are valid off chain and cannot be broadcast.
import { P2PKH, Transaction } from '@bsv/sdk'
import { AuthBoltTemplate, MinSimpleTemplate, Pay2ProofTemplate, buildOutpoint, issuerPubKeyOf, recognizeType } from 'b017'

export const NFT_TYPES = ['MinSimpleBOLT', 'AuthBOLT']
const ZERO20 = new Array(20).fill(0)
const ZERO36 = new Array(36).fill(0)
const COMMIT = [0x21]
const SETTLED = [0x00]
const FINAL = 0xffffffff
// Lock data pushes of the NFT family, in order.
const OWNER = 0; const PARENT = 3

const templates = { MinSimpleBOLT: new MinSimpleTemplate(), AuthBOLT: new AuthBoltTemplate() }
const proof = new Pay2ProofTemplate()
const p2pkh = new P2PKH()

const unlock = (type, key, beneficiary, prevTxs, auth) =>
  type === 'AuthBOLT'
    ? templates.AuthBOLT.unlock(key, beneficiary, prevTxs, auth ?? [])
    : templates.MinSimpleBOLT.unlock(key, beneficiary, prevTxs)

const field = (lock, i) => lock.chunks[i]?.data ?? []
const isZero = (bytes) => bytes.every((b) => b === 0)

/** Read the token at `tx:vout`, or null when that output is not an NFT-family token. */
export function readToken (tx, vout = 0) {
  const lock = tx.outputs[vout]?.lockingScript
  const type = lock && recognizeType(lock)
  if (!type || !NFT_TYPES.includes(type)) return null
  return {
    type,
    tx,
    vout,
    owner: field(lock, OWNER),
    parent: field(lock, PARENT),
    issuer: issuerPubKeyOf(lock, type),
    isMint: isZero(field(lock, PARENT))
  }
}

const input = (sourceTransaction, sourceOutputIndex, unlockingScriptTemplate) =>
  ({ sourceTransaction, sourceOutputIndex, unlockingScriptTemplate, sequence: FINAL })

/** `fund` is `{ tx, vout }`, a P2PKH output the signing key owns; `fee` is taken from its change. */
function addFunding (tx, key, fund, fee, changeTo) {
  if (!fund) return
  const sats = fund.tx.outputs[fund.vout].satoshis
  const spent = tx.outputs.reduce((sum, o) => sum + o.satoshis, 0) - 1 // the token input brings 1 sat
  const change = sats - spent - fee
  if (change < 1) throw new Error(`funding of ${sats} sat does not cover the outputs and a fee of ${fee} sat`)
  tx.addInput(input(fund.tx, fund.vout, p2pkh.unlock(key)))
  tx.addOutput({ satoshis: change, lockingScript: p2pkh.lock(changeTo) })
}

/** The genesis: the issuer's funding becomes a token the issuer owns. */
export function buildMint ({ type, key, issuerPubKey, issuerPkh, fund, fee }) {
  const tx = new Transaction()
  tx.version = 2
  tx.addInput(input(fund.tx, fund.vout, p2pkh.unlock(key)))
  tx.addOutput({ satoshis: 1, lockingScript: templates[type].lock(issuerPkh, issuerPubKey) })
  const change = fund.tx.outputs[fund.vout].satoshis - 1 - fee
  if (change < 1) throw new Error('funding does not cover the mint')
  tx.addOutput({ satoshis: change, lockingScript: p2pkh.lock(issuerPkh) })
  return tx
}

/** Commit `token` to `toPkh`. The token stays with its owner until the settle. */
export function buildCommit ({ token, key, toPkh, auth, fund, fee = 0 }) {
  const tx = new Transaction()
  tx.version = 2
  tx.addInput(input(token.tx, token.vout, unlock(token.type, key, toPkh, [], auth)))
  tx.addOutput({
    satoshis: 1,
    lockingScript: templates[token.type].lock(token.owner, token.issuer, toPkh, COMMIT, buildOutpoint(token.tx, token.vout), token.parent)
  })
  tx.addOutput({ satoshis: 1, lockingScript: proof.lock(toPkh) })
  // An unfunded commit pays out one more sat than it takes in: it can never be broadcast.
  addFunding(tx, key, fund, fee, token.owner)
  return tx
}

/** Settle `commit` (built from `token`) to `toPkh`. */
export function buildSettle ({ token, commit, key, toPkh, auth, fund, fee = 0 }) {
  const tx = new Transaction()
  tx.version = 2
  // The commit before this one is where the current owner received the token; its proof output is co-spent
  // and the covenant rebuilds it. The unlocker finds it at prevTxs[length - 3] of an even-length lineage.
  const earlier = token.isMint ? null : token.tx.inputs[0].sourceTransaction
  if (!token.isMint && !earlier) throw new Error('the commit before the held token is missing: it is needed to settle')
  const prevTxs = earlier ? [token.tx, earlier, token.tx, commit] : [token.tx, commit]
  tx.addInput(input(commit, 0, unlock(token.type, key, toPkh, prevTxs, auth)))
  if (earlier) tx.addInput(input(earlier, 1, proof.unlock(key)))
  tx.addOutput({
    satoshis: 1,
    lockingScript: templates[token.type].lock(toPkh, token.issuer, ZERO20, SETTLED, buildOutpoint(commit, 0), buildOutpoint(token.tx, token.vout))
  })
  // A settle with a proof input takes in 2 sat and pays out 1, so it needs 1 sat less from its funding.
  addFunding(tx, key, fund, fee - (earlier ? 1 : 0), token.owner)
  return tx
}

export { ZERO36 }
