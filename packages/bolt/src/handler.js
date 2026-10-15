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
import { meltFungible, mergeFungible, mintFungible, reconstructFungible, selfFundable, splitFungible, transferFungible } from './fungible.js'
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
    if (token.type === 'SimpleMultiBOLT') return this.#transferFungible(id, token, to, { fundSats })
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

  async #transferFungible (id, token, to, { fundSats = 1000 } = {}) {
    const toPubKey = bytesOf(to)
    if (toPubKey.length !== 33) throw new Error('a SimpleMultiBOLT transfer needs the recipient 33-byte public key')
    const signer = await walletSigner(this.core, this.keyId)
    const t = reconstructFungible(token.tx, signer, token.vout)
    const { commit, settle } = await transferFungible(t, toPubKey, await this.#fundingFor(t, signer, fundSats))
    await this.#send(commit, 'commit')
    await this.#send(settle, 'settle')
    await this.core.store.delete(id)
    return { package: [commit, settle].map((tx) => hex(toAtomicBeef(tx))) }
  }

  /**
   * Pay `amount` of a fungible token (issuer's compressed pubkey, hex) to `to` (recipient 33-byte
   * pubkey): splits a held token, keeping the remainder, and returns the package for the recipient's
   * piece. An exact amount transfers the whole token. When no single held token covers the amount,
   * held tokens of that issuer are merged (largest first) until one does. A token the wallet owns
   * funds each leg from its own change; only a received split piece (no change of its own) draws a
   * fresh output from the wallet's p2pkh fund/change rail, and its remainder self-funds after.
   * Every step is on the network and in the store before the next begins.
   * @returns `{ package }`
   */
  async pay (issuer, amount, to) {
    const iss = issuer.toLowerCase()
    const toPubKey = bytesOf(to)
    if (toPubKey.length !== 33) throw new Error('pay needs the recipient 33-byte public key')
    const want = BigInt(amount)
    if (want <= 0n) throw new Error('amount must be positive')
    const signer = await walletSigner(this.core, this.keyId)
    let { id, have } = await this.#gather(iss, want, signer)
    const t = await this.#fungible(id, signer)

    if (have === want) {
      const { commit, settle } = await transferFungible(t, toPubKey, await this.#fundingFor(t, signer))
      await this.#send(commit, 'commit'); await this.#send(settle, 'settle')
      await this.core.store.delete(id)
      return { package: [commit, settle].map((tx) => hex(toAtomicBeef(tx))) }
    }

    // split needs a grandparent; a genesis / single-hop token gets a self-transfer first to build one.
    if (t.prevTxs.length < 3) id = await this.#selfTransfer(id, t, signer)
    // after a transfer (own or self) the settle's change pays this key, so the split self-funds
    const { commit, settle } = await splitFungible(t, signer.publicKey, toPubKey, amount, await this.#fundingFor(t, signer))
    await this.#send(commit, 'commit')
    const settleStatus = await this.#send(settle, 'settle')
    await this.#keep(settle, 0, { kind: 'settle', network: settleStatus, provenance: null }) // remainder to self
    await this.core.store.delete(id)
    return { package: [commit, settle].map((tx) => hex(toAtomicBeef(tx))) }
  }

  /** Melt a held fungible token: one broadcast transaction destroys it and returns its satoshis to
   *  this wallet's key. @returns `{ txid }` */
  async melt (id) {
    const signer = await walletSigner(this.core, this.keyId)
    const t = await this.#fungible(id, signer)
    // a melt is funded from the token's own change; a split piece has none until it is self-transferred
    if (!selfFundable(t)) id = await this.#selfTransfer(id, t, signer)
    const tx = await meltFungible(t)
    await this.#send(tx, 'melt')
    await this.core.store.delete(id)
    return { txid: tx.id('hex') }
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
   * @returns `{ ok, reason? }` and, when ok: `kind` ('transfer' | 'split' | 'presentation'), `type`,
   *          `issuer`, `owner`/`holder` (settle vout 0; a split also pays vout 1), `data` (AuthBOLT), `tokenId`
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
    if (events.length !== 1 || !['transfer', 'split'].includes(events[0].kind)) {
      return { ok: false, reason: 'a package holds exactly one transfer or split (commit and settle)' }
    }

    const [commit, settle] = events[0].txids.map((txid) => txs.find((tx) => tx.id('hex') === txid))
    const settled = readToken(settle)
    const spent = readToken(commit) // the commit's token output still names the holder who signed
    const data = result.type === 'AuthBOLT' ? (commit.inputs[0].unlockingScript.chunks[0].data ?? []) : undefined
    return {
      ok: true,
      kind: result.offChainOnly ? 'presentation' : events[0].kind,
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

  /** Verify a transfer or split addressed to this wallet, see that the network has it, and keep the
   *  output that pays this wallet (vout 0 for a transfer, vout 1 for a split piece). */
  async receive (pkg, opts = {}) {
    const { txs, anchors, ...checked } = await this.verify(pkg, opts)
    if (!checked.ok) return checked
    if (checked.kind === 'presentation') return { ok: false, reason: 'this package is a presentation, not a transfer: nothing to keep' }
    // Find the settle output addressed to this wallet (a split pays two owners; only one is ours).
    const myPkh = (await this.getKey()).pubKeyHash
    const settle = txs.settle
    let vout = -1
    for (let v = 0; v < settle.outputs.length; v++) {
      const t = readToken(settle, v)
      if (t && hex(t.owner) === myPkh) { vout = v; break }
    }
    if (vout < 0) return { ok: false, reason: 'the token is not addressed to this wallet' }
    // The settle becomes the anchor of whatever this wallet does next, so the network must have it.
    let settleStatus = null
    for (const [name, tx] of Object.entries(txs)) {
      const sent = await this.core.broadcast(tx)
      if (sent.status === 'rejected') return { ok: false, reason: `the network refused the ${name}: ${sent.detail ?? ''}` }
      if (name === 'settle') settleStatus = sent.status
    }
    // Keep the output that pays us, recording everything we know about its anchor: the settle it rests
    // on (network status + proof state against our headers) and the anchor the package descended from.
    const kept = await this.#keep(settle, vout, { kind: 'settle', network: settleStatus, provenance: anchors?.[0] ?? null })
    return { ...checked, tokenId: kept.id }
  }

  // ---- internals ----

  /** Funding for a fungible op on `t`: nothing when the token funds itself from its own change (the
   *  usual case, free), else a fresh wallet p2pkh output — the ordinary fund/change rail — which is
   *  what lets a received split piece (no change of its own) spend like any token. */
  async #fundingFor (t, signer, sats = 1000) {
    if (selfFundable(t)) return undefined
    return this.core.fund(new P2PKH().lock(Hash.hash160(signer.publicKey)), sats)
  }

  /** A held SimpleMultiBOLT as a b017 instance this wallet's signer can spend. */
  async #fungible (id, signer) {
    const token = await this.#held(id)
    if (token.type !== 'SimpleMultiBOLT') throw new Error(`token ${id} is a ${token.type}, not a fungible SimpleMultiBOLT`)
    return reconstructFungible(token.tx, signer, token.vout)
  }

  /** Transfer `t` (held as `id`) to this wallet's own key, on the network and in the store; returns
   *  the new id. It builds the grandparent b017's split and merge spend, and gives a split piece a
   *  change output of its own. `t` is left at the new settle. */
  async #selfTransfer (id, t, signer) {
    const { commit, settle } = await transferFungible(t, signer.publicKey, await this.#fundingFor(t, signer))
    await this.#send(commit, 'self-commit')
    const network = await this.#send(settle, 'self-settle')
    const kept = await this.#keep(settle, 0, { kind: 'settle', network, provenance: null })
    await this.core.store.delete(id)
    return kept.id
  }

  /** A held token of `iss` covering `want`: the smallest single one that does, else the largest
   *  merged with the next largest until they do. @returns `{ id, have }` */
  async #gather (iss, want, signer) {
    const held = (await this.core.store.list())
      .filter((r) => r.type === 'SimpleMultiBOLT' && r.issuer === iss && r.amount != null)
      .map((r) => ({ id: r.id, have: BigInt(r.amount) }))
      .sort((a, b) => (a.have < b.have ? -1 : a.have > b.have ? 1 : 0))
    const single = held.find((r) => r.have >= want)
    if (single) return single
    const total = held.reduce((sum, r) => sum + r.have, 0n)
    if (total < want) throw new Error(`this wallet holds ${total} of ${iss}, not at least ${want}`)
    let acc = held.pop()
    while (acc.have < want) {
      const next = held.pop()
      acc = { id: await this.#merge(acc.id, next.id, signer), have: acc.have + next.have }
    }
    return acc
  }

  /** Merge two held tokens of one issuer into one (commit and settle broadcast); returns its id. */
  async #merge (idA, idB, signer) {
    const a = await this.#fungible(idA, signer)
    const b = await this.#fungible(idB, signer)
    if (a.prevTxs.length < 3) idA = await this.#selfTransfer(idA, a, signer)
    if (b.prevTxs.length < 3) idB = await this.#selfTransfer(idB, b, signer)
    // either token's own change can fund the merge; a wallet output only when neither carries one
    const fund = selfFundable(a) ? undefined
      : selfFundable(b) ? { tx: b.tx, vout: b.tx.outputs.length - 1 }
        : await this.#fundingFor(a, signer)
    const { commit, settle } = await mergeFungible(a, b, signer.publicKey, fund)
    await this.#send(commit, 'merge-commit')
    const network = await this.#send(settle, 'merge-settle')
    const kept = await this.#keep(settle, 0, { kind: 'settle', network, provenance: null })
    await this.core.store.delete(idA)
    await this.core.store.delete(idB)
    return kept.id
  }

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
