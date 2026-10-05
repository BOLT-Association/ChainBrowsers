// The BOLT handler: the page-facing operations, built on b017 and a wallet core (core.js).
//
// A token rests at an ANCHOR: a mint or a settle the network has seen. Two things can stand on it:
//   - a TRANSFER: a funded commit and settle, broadcast, after which the token rests at the new settle;
//   - a PRESENTATION: an unfunded commit and settle that carry up to 75 bytes of data (AuthBOLT). They are
//     never broadcast, the token stays where it was, and the holder can present again. A relying party
//     that receives one learns that the holder controls a token of that issuer and chose that data.
// Either way what travels is `[beef(commit), beef(settle)]`: Atomic BEEF hex, with the anchor inside.
import { Hash, P2PKH, Utils } from '@bsv/sdk'
import { AUTH_DATA_MAX_BYTES, fromBeef, toAtomicBeef, verifyAndBroadcast } from 'b017'
import { NFT_TYPES, buildCommit, buildMint, buildSettle, indexFields, readToken } from './nft.js'
import { mintFungible, reconstructFungible, transferFungible } from './fungible.js'
import { signWith, sizeOf, walletSigner } from './signer.js'

const hex = (bytes) => Utils.toHex(bytes)
const bytesOf = (x) => (typeof x === 'string' ? Utils.toArray(x, 'hex') : Array.from(x ?? []))
const idOf = (tx, vout = 0) => `${tx.id('hex')}.${vout}`

export class BoltHandler {
  /**
   * @param core            the wallet core (see core.js)
   * @param trustedIssuers  issuer public keys (hex) this wallet accepts tokens from; a call may narrow it
   * @param keyId           which wallet key holds tokens
   * @param feePerKb        satoshis per 1000 bytes for funded transactions
   */
  constructor ({ core, trustedIssuers = [], keyId = '1', feePerKb = 100 }) {
    this.core = core
    this.trustedIssuers = trustedIssuers.map((k) => k.toLowerCase())
    this.keyId = keyId
    this.feePerKb = feePerKb
  }

  /** The key to receive tokens at. A sender needs `pubKeyHash`. */
  async getKey () {
    const publicKey = await this.core.publicKey(this.keyId)
    return { publicKey: hex(publicKey), pubKeyHash: hex(Hash.hash160(publicKey)) }
  }

  /** Tokens held. Fungible rows carry their `amount`. */
  async list () {
    return (await this.core.store.list()).map(({ id, type, issuer, amount }) =>
      ({ id, type, issuer, ...(amount != null ? { amount } : {}) }))
  }

  /** The fungible balance of one token: the sum of held outputs of that (issuer, type), as a string. */
  async balance (issuer, type = 'SimpleMultiBOLT') {
    const iss = issuer.toLowerCase()
    if (this.core.store.balance) return this.core.store.balance(iss, type)
    let sum = 0n
    for (const r of await this.core.store.list()) {
      if (r.issuer === iss && r.type === type && r.amount != null) sum += BigInt(r.amount)
    }
    return sum.toString()
  }

  /** Mint a token as its issuer (the wallet's key becomes the issuer key) and broadcast it. A fungible
   *  mint (SimpleMultiBOLT) takes an `amount`; the NFT family does not. */
  async mint ({ type = 'AuthBOLT', fundSats = 1000, amount } = {}) {
    if (type === 'SimpleMultiBOLT') return this.#mintFungible({ amount, fundSats })
    if (!NFT_TYPES.includes(type)) throw new Error(`cannot mint ${type}: supported types are ${NFT_TYPES.join(', ')}, SimpleMultiBOLT`)
    const issuerPubKey = await this.core.publicKey(this.keyId)
    const issuerPkh = Hash.hash160(issuerPubKey)
    const fund = await this.core.fund(new P2PKH().lock(issuerPkh), fundSats)
    const tx = await this.#sign((key, fee) => buildMint({ type, key, issuerPubKey, issuerPkh, fund, fee }))
    const network = await this.#send(tx, 'mint')
    return this.#keep(tx, 0, { kind: 'mint', network, provenance: null })
  }

  async #mintFungible ({ amount, fundSats }) {
    if (amount === undefined || amount === null) throw new Error('minting a SimpleMultiBOLT requires an amount')
    const signer = await walletSigner(this.core, this.keyId)
    const fund = await this.core.fund(new P2PKH().lock(Hash.hash160(signer.publicKey)), fundSats)
    const t = await mintFungible({ signer, fund, amount })
    const network = await this.#send(t.tx, 'mint')
    return this.#keep(t.tx, 0, { kind: 'mint', network, provenance: null })
  }

  /**
   * Transfer a held token, a funded commit and settle, both broadcast.
   * @param to  NFT family: the recipient's 20-byte pubKeyHash. SimpleMultiBOLT: the recipient's
   *            33-byte compressed public key (the covenant derives the hash itself).
   * @returns `{ package }` for the recipient's `receive`
   */
  async transfer (id, to, { fundSats = 1000 } = {}) {
    const token = await this.#held(id)
    if (token.type === 'SimpleMultiBOLT') return this.#transferFungible(id, token, to)
    const toPkh = bytesOf(to)
    if (toPkh.length !== 20) throw new Error('an NFT transfer needs the recipient 20-byte pubKeyHash')
    const fund = await this.core.fund(new P2PKH().lock(token.owner), fundSats)
    const commit = await this.#sign((key, fee) => buildCommit({ token, key, toPkh, fund, fee }))
    const change = { tx: commit, vout: commit.outputs.length - 1 }
    const settle = await this.#sign((key, fee) => buildSettle({ token, commit, key, toPkh, fund: change, fee }))
    await this.#send(commit, 'commit')
    await this.#send(settle, 'settle')
    await this.core.store.delete(id)
    return { package: [commit, settle].map((tx) => hex(toAtomicBeef(tx))) }
  }

  async #transferFungible (id, token, to) {
    const toPubKey = bytesOf(to)
    if (toPubKey.length !== 33) throw new Error('a SimpleMultiBOLT transfer needs the recipient 33-byte public key')
    const signer = await walletSigner(this.core, this.keyId)
    const t = reconstructFungible(token.tx, signer)
    const { commit, settle } = await transferFungible(t, toPubKey)
    await this.#send(commit, 'commit')
    await this.#send(settle, 'settle')
    await this.core.store.delete(id)
    return { package: [commit, settle].map((tx) => hex(toAtomicBeef(tx))) }
  }

  /**
   * Present a held AuthBOLT token with `data` (up to 75 bytes, e.g. a site's challenge). Nothing is
   * broadcast and the token stays held.
   * @param to  the relying party's pubKeyHash, when it gave one; defaults to the holder's own
   * @returns `{ package }` for the relying party's `verify`
   */
  async present (id, { data = [], to } = {}) {
    const token = await this.#held(id)
    if (token.type !== 'AuthBOLT') throw new Error(`a ${token.type} token carries no data: only AuthBOLT can be presented`)
    const auth = bytesOf(data)
    if (auth.length > AUTH_DATA_MAX_BYTES) throw new Error(`data is ${auth.length} bytes; the maximum is ${AUTH_DATA_MAX_BYTES}`)
    const toPkh = to ? bytesOf(to) : token.owner
    const commit = await signWith(this.core, this.keyId, (key) => buildCommit({ token, key, toPkh, auth }))
    const settle = await signWith(this.core, this.keyId, (key) => buildSettle({ token, commit, key, toPkh }))
    return { package: [commit, settle].map((tx) => hex(toAtomicBeef(tx))) }
  }

  /**
   * Check a package: scripts executed, issuer trusted, anchor proven by the wallet's headers or accepted by
   * the network. Never stores anything.
   * @param issuer  narrow the trusted issuers to this one public key (hex)
   * @returns `{ ok, reason? }` and, when ok: `kind` ('transfer' | 'presentation'), `type`, `issuer`,
   *          `owner` (pubKeyHash the settle pays), `holder` (pubKeyHash that signed), `data` (AuthBOLT), `tokenId`
   */
  async verify (pkg, { issuer } = {}) {
    let txs
    try {
      txs = pkg.map((entry) => fromBeef(entry))
    } catch (e) {
      return { ok: false, reason: `invalid package: ${e.message}` }
    }
    const trusted = issuer ? [issuer.toLowerCase()] : this.trustedIssuers
    if (trusted.length === 0) return { ok: false, reason: 'no trusted issuer: pass one, or configure trustedIssuers' }
    const named = txs.map((tx) => readToken(tx)).find(Boolean)
    if (!named) return { ok: false, reason: 'no BOLT token in the package' }
    if (!trusted.includes(hex(named.issuer))) return { ok: false, reason: `issuer ${hex(named.issuer)} is not trusted` }

    const result = await verifyAndBroadcast(txs, (tx) => this.core.broadcast(tx), {
      trustedIssuerPubKey: named.issuer,
      chainTracker: { isValidRootForHeight: (root, height) => this.core.isValidRootForHeight(root, height) }
    })
    if (!result.ok) return { ok: false, reason: result.reason }
    const events = result.events.filter((e) => e.kind !== 'mint')
    if (events.length !== 1 || events[0].kind !== 'transfer') return { ok: false, reason: 'a package holds exactly one commit and settle' }

    const [commit, settle] = events[0].txids.map((txid) => txs.find((tx) => tx.id('hex') === txid))
    const settled = readToken(settle)
    const spent = readToken(commit) // the commit's token output still names the holder who signed
    const data = result.type === 'AuthBOLT' ? (commit.inputs[0].unlockingScript.chunks[0].data ?? []) : undefined
    return {
      ok: true,
      kind: result.offChainOnly ? 'presentation' : 'transfer',
      type: result.type,
      issuer: result.issuerPubKeyHex,
      owner: hex(settled.owner),
      holder: hex(spent.owner),
      data: data && hex(data),
      tokenId: idOf(settle),
      anchors: result.anchors, // what the package stood on: [{ txid, kind, status }]
      txs: { commit, settle }
    }
  }

  /** Verify a transfer addressed to this wallet, see that the network has it, and keep the token. */
  async receive (pkg, opts = {}) {
    const { txs, anchors, ...checked } = await this.verify(pkg, opts)
    if (!checked.ok) return checked
    if (checked.kind !== 'transfer') return { ok: false, reason: 'this package is a presentation, not a transfer: nothing to keep' }
    if (checked.owner !== (await this.getKey()).pubKeyHash) return { ok: false, reason: 'the token is not addressed to this wallet' }
    // The settle becomes the anchor of whatever this wallet does next, so the network must have it.
    let settleStatus = null
    for (const [name, tx] of Object.entries(txs)) {
      const sent = await this.core.broadcast(tx)
      if (sent.status === 'rejected') return { ok: false, reason: `the network refused the ${name}: ${sent.detail ?? ''}` }
      if (name === 'settle') settleStatus = sent.status
    }
    // Keep the token, recording everything we know about its anchor: the settle it rests on (network
    // status + proof state against our headers) and the anchor the package descended from (provenance).
    await this.#keep(txs.settle, 0, { kind: 'settle', network: settleStatus, provenance: anchors?.[0] ?? null })
    return checked
  }

  // ---- internals ----

  async #held (id) {
    const record = await this.core.store.get(id)
    if (!record) throw new Error(`no token ${id} in this wallet`)
    const token = readToken(fromBeef(record.beef), record.vout)
    if (hex(token.owner) !== (await this.getKey()).pubKeyHash) throw new Error(`token ${id} is not owned by this wallet's key`)
    return token
  }

  async #keep (tx, vout = 0, meta = {}) {
    const token = readToken(tx, vout)
    const { amount, attributes } = indexFields(token)
    const anchor = await this.#anchor(tx, meta.kind ?? 'settle', meta.network)
    const record = {
      id: idOf(tx, vout),
      outpoint: idOf(tx, vout),
      vout,
      type: token.type,
      issuer: hex(token.issuer),
      owner: hex(token.owner),
      status: 'held',
      amount,
      attributes,
      beef: hex(toAtomicBeef(tx)),
      anchor,
      provenance: meta.provenance ?? null
    }
    await this.core.store.put(record)
    return { id: record.id, type: record.type, issuer: record.issuer }
  }

  /**
   * Everything we know about the anchor the token rests on: its txid and kind, the network status
   * last reported, and whether its merkle path proves it into a header we hold (so a later proof-poll
   * or reorg recheck has a baseline). A freshly broadcast token is usually not yet proven.
   */
  async #anchor (tx, kind, network) {
    let proven = false; let height; let merkleRoot
    if (tx.merklePath) {
      try {
        const root = tx.merklePath.computeRoot(tx.id('hex'))
        if (await this.core.isValidRootForHeight(root, tx.merklePath.blockHeight)) {
          proven = true; height = tx.merklePath.blockHeight; merkleRoot = root
        }
      } catch { /* not proven; leave it unproven */ }
    }
    return { txid: tx.id('hex'), kind, network: network ?? null, proven, height, merkleRoot }
  }

  /** Size the tx with a zero fee, then sign it with the fee that size needs. */
  async #sign (build) {
    const size = await sizeOf(this.core, this.keyId, (key) => build(key, 0))
    const fee = Math.max(1, Math.ceil((size * this.feePerKb) / 1000))
    return signWith(this.core, this.keyId, (key) => build(key, fee))
  }

  async #send (tx, name) {
    const sent = await this.core.broadcast(tx)
    if (sent.status === 'rejected') throw new Error(`the network refused the ${name}: ${sent.detail ?? 'no detail'}`)
    return sent.status
  }
}
