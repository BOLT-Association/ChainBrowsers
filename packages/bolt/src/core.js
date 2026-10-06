// The wallet core: the six things the BOLT handler needs from a wallet.
//
//   publicKey(keyId)                  -> number[33]   the key tokens are locked to
//   signDigest(keyId, digest32)       -> number[]     DER signature of a 32-byte digest by that key
//   isValidRootForHeight(root, height)-> boolean      the wallet's own verified headers
//   broadcast(tx)                     -> { status: 'accepted' | 'already-seen' | 'rejected', detail? }
//   fund(lockingScript, satoshis)     -> { tx, vout } a transaction paying that script, sources attached
//   store                             -> { put, get, list, delete } for held tokens
//
// `brc100Core` provides them from a BRC-100 wallet and Arcade, so the handler runs beside the existing
// interface in both browsers. A wallet can also implement the six directly.
import { Transaction, Utils } from '@bsv/sdk'

/** BRC-43 protocol for token keys: security level 1 (asked once per app), a fixed name. */
export const BOLT_PROTOCOL = [1, 'bolt token']

export function memoryStore () {
  const records = new Map()
  return {
    put: async (record) => { records.set(record.id, record) },
    get: async (id) => records.get(id),
    list: async () => [...records.values()],
    delete: async (id) => { records.delete(id) }
  }
}

const SEEN = new Set(['SEEN_ON_NETWORK', 'SEEN_ON_MULTIPLE_NODES', 'ACCEPTED_BY_NETWORK', 'MINED', 'IMMUTABLE'])
const REFUSED = new Set(['REJECTED', 'DOUBLE_SPEND_ATTEMPTED'])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether `tx` carries a merkle path that proves it into the wallet's own headers: such a tx is
 *  mined, whether or not the broadcaster in use has ever heard of it. */
export async function provenInHeaders (tx, isValidRootForHeight) {
  if (!tx.merklePath || !isValidRootForHeight) return false
  try {
    return await isValidRootForHeight(tx.merklePath.computeRoot(tx.id('hex')), tx.merklePath.blockHeight)
  } catch {
    return false // cannot tell: let the network answer
  }
}

/**
 * Broadcast through Arcade and wait for a network status. Arcade answers 202 for anything well formed, so
 * the verdict is the status that follows.
 * @param isValidRootForHeight  when given, a tx whose merkle path proves it into the wallet's headers is
 *                              reported as already seen without asking Arcade
 */
export function arcadeBroadcaster ({ arcadeUrl, isValidRootForHeight, fetch = globalThis.fetch, timeoutMs = 20000, everyMs = 500 }) {
  const statusOf = async (txid) => {
    const res = await fetch(`${arcadeUrl}/tx/${txid}`)
    if (!res.ok) return undefined
    return (await res.json()).txStatus
  }
  return async (tx) => {
    const txid = tx.id('hex')
    if (await provenInHeaders(tx, isValidRootForHeight)) return { status: 'already-seen', detail: 'mined' }
    const known = await statusOf(txid).catch(() => undefined)
    if (SEEN.has(known)) return { status: 'already-seen', detail: known }

    // Extended Format carries each input's source output, which Arcade needs for an unmined parent.
    const extended = tx.inputs.every((i) => i.sourceTransaction)
    const res = await fetch(`${arcadeUrl}/tx`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: extended ? tx.toHexEF() : tx.toHex()
    })
    if (res.status !== 200 && res.status !== 202) {
      return { status: 'rejected', detail: `arcade ${res.status}: ${(await res.text()).slice(0, 200)}` }
    }
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      const status = await statusOf(txid).catch(() => undefined)
      if (SEEN.has(status)) return { status: 'accepted', detail: status }
      if (REFUSED.has(status)) return { status: 'rejected', detail: status }
      await sleep(everyMs)
    }
    return { status: 'rejected', detail: 'no network status from arcade in time' }
  }
}

/** The merkle root inside an 80-byte block header (hex), as the display-order hex a merkle path computes. */
const rootOfHeader = (headerHex) => Utils.toHex(Utils.toArray(headerHex, 'hex').slice(36, 68).reverse())

/**
 * A wallet core on top of a BRC-100 wallet (`getPublicKey`, `createSignature`, `getHeaderForHeight`,
 * `createAction`) and Arcade.
 * @param wallet     anything with those four methods: `window.CWI`, a toolbox Wallet, an HTTP client
 * @param arcadeUrl  Arcade's API (`:8080` on the local stack); or pass `broadcast`, a
 *                   `(tx) => { status, detail }` that reaches the network another way (wallet-rail.js)
 */
export function brc100Core ({ wallet, arcadeUrl, broadcast, store = memoryStore(), protocolID = BOLT_PROTOCOL, fetch = globalThis.fetch }) {
  const key = (keyID) => ({ protocolID, keyID, counterparty: 'self' })
  const isValidRootForHeight = async (root, height) => {
    const { header } = await wallet.getHeaderForHeight({ height })
    return typeof header === 'string' && rootOfHeader(header) === root
  }
  const net = broadcast ?? arcadeBroadcaster({ arcadeUrl, fetch })
  return {
    store,
    isValidRootForHeight,
    publicKey: async (keyId) => Utils.toArray((await wallet.getPublicKey(key(keyId))).publicKey, 'hex'),
    signDigest: async (keyId, digest) => (await wallet.createSignature({ ...key(keyId), hashToDirectlySign: digest })).signature,
    // Whatever the broadcaster, a tx already proven by the wallet's headers is not sent again.
    broadcast: async (tx) => (await provenInHeaders(tx, isValidRootForHeight))
      ? { status: 'already-seen', detail: 'mined' }
      : net(tx),
    fund: async (lockingScript, satoshis) => {
      const { tx } = await wallet.createAction({
        description: 'Fund a BOLT token transaction',
        outputs: [{ lockingScript: lockingScript.toHex(), satoshis, outputDescription: 'BOLT funding' }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      return { tx: Transaction.fromAtomicBEEF(tx), vout: 0 }
    }
  }
}
