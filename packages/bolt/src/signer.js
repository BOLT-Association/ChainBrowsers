// Signing through a wallet that never hands out its key.
//
// b017's unlock templates (and the SDK's P2PKH) take a PrivateKey and call two things on it, synchronously:
// `sign(sha256(preimage))` and `toPublicKey()`. A wallet signs asynchronously, so a transaction is built twice
// with a stand-in key: the first pass records the digests the templates ask for, the wallet signs them, and the
// second pass replays the signatures. A preimage does not depend on any unlocking script, so both passes ask
// for the same digests.
import { BigNumber, Curve, Hash, PublicKey, Signature, Utils } from '@bsv/sdk'

const curve = new Curve()
const halfN = curve.n.divn(2)
const PLACEHOLDER = new Signature(new BigNumber(1), new BigNumber(1))

/** PrivateKey.sign(msg) signs sha256(msg): that 32-byte value is what the wallet is asked to sign. */
const digestOf = (msg) => Utils.toHex(Hash.sha256(msg))

/** Script signatures must be low-S; a wallet may return either form. */
const lowS = (sig) => (sig.s.cmp(halfN) > 0 ? new Signature(sig.r, curve.n.sub(sig.s)) : sig)

/**
 * Build and sign a transaction with the wallet's key `keyId`.
 * @param core   the wallet core (`publicKey`, `signDigest`)
 * @param build  `(key) => Transaction`: builds the unsigned tx, handing `key` to every unlock template
 */
export async function signWith (core, keyId, build) {
  const publicKey = PublicKey.fromString(Utils.toHex(await core.publicKey(keyId)))
  const wanted = []
  const recorder = { toPublicKey: () => publicKey, sign: (msg) => { wanted.push(digestOf(msg)); return PLACEHOLDER } }
  await (await build(recorder)).sign()

  const signed = new Map()
  for (const digest of new Set(wanted)) {
    const der = await core.signDigest(keyId, Utils.toArray(digest, 'hex'))
    signed.set(digest, lowS(Signature.fromDER(der)))
  }
  const replay = {
    toPublicKey: () => publicKey,
    sign: (msg) => {
      const sig = signed.get(digestOf(msg))
      if (!sig) throw new Error('the second signing pass asked for a digest the first did not')
      return sig
    }
  }
  const tx = await build(replay)
  await tx.sign()
  return tx
}

/** The serialised size of the tx `build` produces, with placeholder signatures (for the fee). */
export async function sizeOf (core, keyId, build) {
  const publicKey = PublicKey.fromString(Utils.toHex(await core.publicKey(keyId)))
  // A real signature is up to 72 bytes; the placeholder is 8. Count the difference once per signature.
  let signatures = 0
  const key = { toPublicKey: () => publicKey, sign: () => { signatures++; return PLACEHOLDER } }
  const tx = await build(key)
  await tx.sign()
  return tx.toBinary().length + signatures * 64
}
