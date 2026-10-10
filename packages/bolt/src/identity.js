// AuthBOLT identities: the wallet side and the relying party's check.
//
// A user is the issuer of their own AuthBOLTs and an app is a verifier. Each identity is one AuthBOLT
// minted under its own key (BRC-43 protocol IDENTITY_PROTOCOL, counted keyIDs `authbolt-<i>`), so two
// identities share nothing an app could link. The issuer key never changes and is what an app records
// as the account; the token moves only to the identity's own holder keys (`authbolt-<i>.holder.<n>`),
// on chain (docs/authbolt-onchain-holder-keys.md):
//   - register: the issuer key moves the token from its mint to holder 1, in a commit carrying the
//     app's register data and a settle, both paid by the app and broadcast;
//   - rotate: when the app asks, the current holder moves it to holder n+1 the same way;
//   - reissue: a lost holder key leaves its token dead, so the issuer key mints a new token for the
//     same identity and moves it to holder n+1.
// The app pays each commit and settle with one coin of exactly what it needs, signed SIGHASH_SINGLE |
// ANYONECANPAY (`funder`), so neither side can divert anything. The count n travels in the auth data,
// and the wallet and the app keep it in step.
//
// AUTH DATA names the app asking (66 bytes; 70 with the count):
//   [tag 1][app public key 33][challenge hash 32] + [holder count 4] for register, rotate, reissue
// tag 0x01 register, 0x02 sign in, 0x03 keep a session alive, 0x04 a write (one change a person makes in
// the app, signed: the hash is the write's own), 0x05 rotate, 0x06 reissue. The app's server makes the
// data from its own challenge; the wallet reads the tag and the app key to word its prompt, and
// refuses data that names another app.
//
// What the wallet remembers about an identity lives in the token row's attributes, under `wallet`:
//   { issuerKeyId, holderKeyId, holderCount, apps: [{ domain, appPubKey, keepSignedIn, linkedAt }] }
// `keepSignedIn` is the user's grant for silent signatures and rotations for that app on that site.
//
// After registering, sign-in, keep-alives and writes are holder-key signatures over
//   sha256("PeerLoop/1\n" ‖ kind ‖ "\n" ‖ app key (33 bytes) ‖ sha256(payload))
// which the wallet builds itself (signDigest) and never takes from a page.
//
// Imports nothing from Node, so it bundles for the browser's trusted UI.
import { Hash, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import { fromBeef, toAtomicBeef } from 'b017'
import { buildCommit, buildMint, buildSettle, readToken } from './nft.js'
import { lowSDer, signWith, sizeOf } from './signer.js'
import { WRITE_TIERS } from './write-tiers.js'

/** The BRC-43 protocol identity keys are derived under: level 2 (per counterparty), its own name, so a
 *  wallet can refuse it to sites and keep identity signing to its own prompt. */
export const IDENTITY_PROTOCOL = [2, 'authbolt identity']
export const AUTH_DATA_BYTES = 66
/** Register, rotate and reissue also carry the holder count (4 bytes, big-endian, at least 1): 70 bytes. */
export const COUNTED_AUTH_DATA_BYTES = 70
const PURPOSES = { register: 1, signin: 2, refresh: 3, write: 4, rotate: 5, reissue: 6 }
const COUNTED = ['register', 'rotate', 'reissue']
const MAX_COUNT = 0xffffffff
const PURPOSE_OF = Object.fromEntries(Object.entries(PURPOSES).map(([k, v]) => [v, k]))

const hex = (bytes) => Utils.toHex(bytes)
const bytesOf = (x) => (typeof x === 'string' ? Utils.toArray(x, 'hex') : Array.from(x ?? []))
const isHex = (s, chars) => typeof s === 'string' && s.length === chars && /^[0-9a-f]+$/i.test(s)
const idOf = (tx, vout = 0) => `${tx.id('hex')}.${vout}`
const p2pkh = new P2PKH()

function checkAppKey (appPubKey) {
  if (!isHex(appPubKey, 66) || !['02', '03'].includes(appPubKey.slice(0, 2).toLowerCase())) {
    throw new Error('the app key must be a 33-byte compressed public key (hex)')
  }
  return appPubKey.toLowerCase()
}

/** Auth data for a presentation (hex): [tag 1][app key 33][challenge hash 32], plus [count 4] when counted. */
export function encodeAuthData ({ purpose, appPubKey, challengeHash, count }) {
  const tag = PURPOSES[purpose]
  if (!tag) throw new Error(`unknown purpose ${purpose}: register, signin, refresh, write, rotate or reissue`)
  if (!isHex(challengeHash, 64)) throw new Error('the challenge hash must be 32 bytes (hex)')
  const counted = COUNTED.includes(purpose)
  if (counted && !(Number.isInteger(count) && count >= 1 && count <= MAX_COUNT)) {
    throw new Error(`${purpose} auth data needs the holder count, an integer from 1 to ${MAX_COUNT}`)
  }
  if (!counted && count !== undefined) throw new Error(`${purpose} auth data carries no count`)
  const tail = counted ? count.toString(16).padStart(8, '0') : ''
  return (tag.toString(16).padStart(2, '0') + checkAppKey(appPubKey) + challengeHash + tail).toLowerCase()
}

/** Read auth data; throws on anything that is not exactly that. */
export function decodeAuthData (data) {
  const s = typeof data === 'string' ? data.toLowerCase() : hex(data)
  if (!isHex(s, s.length) || s.length < 2) throw new Error('auth data must be hex')
  const purpose = PURPOSE_OF[parseInt(s.slice(0, 2), 16)]
  if (!purpose) throw new Error(`unknown purpose tag 0x${s.slice(0, 2)}`)
  const counted = COUNTED.includes(purpose)
  const bytes = counted ? COUNTED_AUTH_DATA_BYTES : AUTH_DATA_BYTES
  if (s.length !== bytes * 2) throw new Error(`${purpose} auth data must be exactly ${bytes} bytes (hex)`)
  let appPubKey
  try { appPubKey = checkAppKey(s.slice(2, 68)) } catch { throw new Error('the auth data does not carry a valid app key') }
  const out = { purpose, appPubKey, challengeHash: s.slice(68, 132) }
  if (counted) {
    out.count = parseInt(s.slice(132), 16)
    if (out.count < 1) throw new Error('the holder count must be at least 1')
  }
  return out
}

const SIGN_PREFIX = 'PeerLoop/1\n'
/** What a holder (or, for recover, the issuer) key signs after registration. */
export const SIGN_KINDS = ['signin', 'refresh', 'write', 'rotate', 'recover']
const MAX_PAYLOAD = 64 * 1024

/** The digest a holder signature covers (32 bytes): the kind and the app key are bound in, and the
 *  prefix keeps it apart from any transaction sighash (a double SHA-256 of a preimage). */
export function signDigest ({ kind, appPubKey, payload }) {
  if (!SIGN_KINDS.includes(kind)) throw new Error(`unknown signed kind ${kind}: ${SIGN_KINDS.join(', ')}`)
  const app = checkAppKey(appPubKey)
  if (typeof payload !== 'string') throw new Error('the payload must be text')
  return Hash.sha256([
    ...Utils.toArray(SIGN_PREFIX + kind + '\n', 'utf8'),
    ...Utils.toArray(app, 'hex'),
    ...Hash.sha256(Utils.toArray(payload, 'utf8'))
  ])
}

/** A write's tier: what the app published, and 'prompted' for anything it did not. */
function tierOfWrite (payload) {
  let w
  try { w = JSON.parse(payload) } catch { throw new Error('a write payload must be the write as JSON') }
  if (typeof w?.kind !== 'string') throw new Error('a write payload must name its kind')
  return Object.hasOwn(WRITE_TIERS, w.kind) ? WRITE_TIERS[w.kind] : 'prompted'
}

/** An error the browser answers by showing its prompt instead of presenting silently. */
function needsPrompt (why) {
  return Object.assign(new Error(why), { code: 'NEEDS_PROMPT' })
}

/** The app pays for every move of an identity token (registration, rotation, reissue). */
function checkFunder (funder) {
  if (typeof funder !== 'function') throw new Error('nobody to pay for moving the identity token: the app funds it (funder)')
}

/**
 * Ask the app for one coin of exactly `amount` sat, signed for the funding input of `draft` (the
 * transaction as built, outputs final, at the index its funding input will take).
 */
async function askFunder (funder, step, draft, amount) {
  if (!Number.isInteger(amount) || amount < 1) throw new Error(`the ${step} needs a funding coin of at least 1 sat, not ${amount}`)
  const coin = await funder({ step, amount, tx: draft, index: draft.inputs.length })
  const sats = coin?.tx?.outputs?.[coin.vout]?.satoshis
  if (sats !== amount || !coin.unlockingScript) throw new Error(`the app's coin for the ${step} must be exactly ${amount} sat and signed`)
  return coin
}

/** A stand-in funding output of the right shape, to measure a transaction before funding it. */
const sizingFund = (pkh) => ({ tx: new Transaction(1, [], [{ satoshis: 1e8, lockingScript: p2pkh.lock(pkh) }], 0), vout: 0 })

/** Holder key n of an identity: an ordinary wallet key, counted, so a seed and the count find it again. */
const holderKeyIdOf = (issuerKeyId, n) => `${issuerKeyId}.holder.${n}`
/** A key for transactions that are built only to be measured or shown to the payer, never signed. */
const draftKey = PrivateKey.fromRandom()

export class IdentityWallet {
  /**
   * @param core       a wallet core whose keys are derived under IDENTITY_PROTOCOL (brc100Core with
   *                   `protocolID: IDENTITY_PROTOCOL`); its store must have `annotate` or `get`+`put`
   * @param feePerKb   satoshis per 1000 bytes for the funded transactions (mint, commit, settle)
   */
  constructor ({ core, feePerKb = 100 }) {
    this.core = core
    this.feePerKb = feePerKb
  }

  /** Every identity this wallet holds, with the apps it is linked to. */
  async identities () {
    const records = await this.core.store.list({ type: 'AuthBOLT' })
    return records.filter((r) => r.type === 'AuthBOLT' && r.status !== 'spent' && r.attributes?.wallet)
      .map((r) => this.#view(r))
  }

  /** The identities linked to this app on this site (what that site may be told about). */
  async forApp ({ domain, appPubKey }) {
    const key = checkAppKey(appPubKey)
    return (await this.identities()).filter((t) => t.apps.some((a) => a.domain === domain && a.appPubKey === key))
  }

  /** Mint a new identity under the next counted key (`authbolt-<i>`), paid by this wallet. */
  async create () {
    const keyId = await this.#nextIdentityKeyId()
    const tx = await this.#mint(keyId)
    const record = await this.#keep(tx, 0, 'mint', { issuerKeyId: keyId, holderKeyId: keyId, holderCount: 0, apps: [] })
    return this.#view(record)
  }

  /**
   * Register identity `id` with an app: the issuer key moves the token from its mint to holder key 1
   * (the count the register data names) in a commit carrying the data and a settle, both paid by the
   * app (`funder`) and broadcast before this returns. Links the identity to the app on this site and
   * records the keep-signed-in choice. Sign-in and keep-alives are signatures (`sign`), never this.
   * @param funder  `({ step, amount, tx, index }) => { tx, vout, unlockingScript }`: the app's coin of
   *                exactly `amount` sat, signed for input `index` of `tx` (SIGHASH_SINGLE | ANYONECANPAY)
   * @returns `{ package, id }`: the commit and settle for the app's server, and the identity's new id
   */
  async present ({ id, domain, appPubKey, data, keepSignedIn, funder }) {
    const { app, decoded } = this.#readFor(appPubKey, data, 'register', 'a presentation is only ever a registration: signing in and keep-alives are signatures')
    if (typeof domain !== 'string' || !domain) throw new Error('a presentation needs the site it is for')
    const record = await this.#record(id)
    const token = await this.#token(record)
    if (!token.isMint) throw new Error('this identity\'s token has moved since its mint, so it proves no ownership: it cannot register')
    this.#checkCount(record, decoded.count)
    checkFunder(funder)
    await this.#link(record, { domain, appPubKey: app, keepSignedIn })
    return this.#move(await this.#record(id), { token, n: decoded.count, data, funder })
  }

  /**
   * The app asked for a rotation: move the token from the current holder key to the next one (the
   * count the rotate data names), paid by the app and broadcast. Silent only under the keep-signed-in
   * grant for that app on that site; behind the prompt the person chose identity `id`.
   * @returns `{ package, id }`
   */
  async rotate ({ id, domain, appPubKey, data, funder, silent }) {
    const { app, decoded } = this.#readFor(appPubKey, data, 'rotate', 'only rotate data moves the token to the next holder')
    const record = await this.#chosen({ id, domain, appPubKey: app, silent })
    this.#checkCount(record, decoded.count)
    checkFunder(funder)
    return this.#move(record, { token: await this.#token(record), n: decoded.count, data, funder })
  }

  /**
   * Recover from a lost holder key. The token held by that key can never move again, so the
   * identity's issuer key mints a new one (the same issuer: the same identity to every app) and
   * moves it to the next holder (the count the reissue data names); the old record goes. Never silent.
   * @returns `{ package, id }`: the new mint travels inside the commit
   */
  async reissue ({ id, domain, appPubKey, data, funder, silent }) {
    if (silent) throw needsPrompt('the wallet always asks before reissuing an identity')
    const { app, decoded } = this.#readFor(appPubKey, data, 'reissue', 'only reissue data recovers an identity')
    const old = await this.#chosen({ id, domain, appPubKey: app, silent: false })
    this.#checkCount(old, decoded.count)
    checkFunder(funder)
    const wallet = old.attributes.wallet
    const mint = await this.#mint(wallet.issuerKeyId)
    const fresh = await this.#keep(mint, 0, 'mint', { ...wallet, holderKeyId: wallet.issuerKeyId })
    await this.core.store.delete(old.id)
    return this.#move(fresh, { token: await this.#token(fresh), n: decoded.count, data, funder })
  }

  /**
   * Sign `payload` as `kind` for an app with the identity's holder key. Silent (no prompt shown) only
   * under the keep-signed-in grant for that app on that site, and only for sign-in, keep-alive and
   * the writes the app's published tiers call silent; anything else throws NEEDS_PROMPT. Behind the
   * wallet's prompt (`silent` false) the person chose the identity `id`.
   * @returns `{ identity, holder, signature }`: the issuer key, the holder key and DER hex
   */
  async sign ({ id, domain, appPubKey, kind, payload, silent }) {
    const app = checkAppKey(appPubKey)
    if (!['signin', 'refresh', 'write'].includes(kind)) throw new Error(`a page may ask to sign signin, refresh or write, not ${kind}`)
    if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD) throw new Error('the payload must be text of at most 64 KiB')
    const tier = kind === 'write' ? tierOfWrite(payload) : 'silent'
    if (silent && tier !== 'silent') {
      await this.#chosen({ domain, appPubKey: app, silent }) // no grant reads as no grant first
      throw needsPrompt('the wallet always asks before signing this change')
    }
    const record = await this.#chosen({ id, domain, appPubKey: app, silent })
    return { identity: record.issuer, ...(await this.#signAs(record.attributes.wallet.holderKeyId, { kind, appPubKey: app, payload })) }
  }

  /**
   * Answer a page's request (Hodos POST /bolt/sign) by kind: signin, refresh and write are
   * signatures (sign); rotate and reissue move the token on chain (the payload is the app's auth
   * data, `funder` the app's coins). The page learns signatures, public keys and the package.
   */
  async answer ({ id, domain, appPubKey, kind, payload, silent, funder }) {
    switch (kind) {
      case 'signin': case 'refresh': case 'write':
        return this.sign({ id, domain, appPubKey, kind, payload, silent })
      case 'rotate':
        return this.rotate({ id, domain, appPubKey, data: payload, funder, silent })
      case 'reissue':
        return this.reissue({ id, domain, appPubKey, data: payload, funder, silent })
      default:
        throw new Error(`unknown kind ${kind}: signin, refresh, write, rotate or reissue`)
    }
  }

  /** Turn the keep-signed-in grant for one app on or off. */
  async setKeepSignedIn ({ id, domain, appPubKey, keep }) {
    const record = await this.#record(id)
    await this.#link(record, { domain, appPubKey: checkAppKey(appPubKey), keepSignedIn: !!keep })
  }

  /** Unlink an identity from an app on a site (the app keeps what it recorded). */
  async forget ({ id, domain, appPubKey }) {
    const record = await this.#record(id)
    const app = checkAppKey(appPubKey)
    const wallet = record.attributes.wallet
    await this.#annotate(record, { ...wallet, apps: wallet.apps.filter((a) => !(a.domain === domain && a.appPubKey === app)) })
  }

  /**
   * The V1 shape: an unfunded self-transfer carrying `data`, which can never be broadcast. Nothing in
   * the wallet uses it any more; verifiers keep it to show they refuse a registration that is not on chain.
   */
  async presentOffChain ({ id, appPubKey, data }) {
    checkAppKey(appPubKey)
    const record = await this.#record(id)
    const token = await this.#token(record)
    const keyId = record.attributes.wallet.holderKeyId
    const auth = bytesOf(data)
    const commit = await signWith(this.core, keyId, (key) => buildCommit({ token, key, toPkh: token.owner, auth }))
    const settle = await signWith(this.core, keyId, (key) => buildSettle({ token, commit, key, toPkh: token.owner }))
    return [commit, settle].map((tx) => hex(toAtomicBeef(tx)))
  }

  // ---- inside ----------------------------------------------------------------------

  /** Decode `data`, which must name this app and be for `purpose`. */
  #readFor (appPubKey, data, purpose, wrongPurpose) {
    const app = checkAppKey(appPubKey)
    const decoded = decodeAuthData(data)
    if (decoded.appPubKey !== app) throw new Error('the auth data names another app than the one asking')
    if (decoded.purpose !== purpose) throw new Error(`${wrongPurpose} (this is ${decoded.purpose} data)`)
    return { app, decoded }
  }

  /** The app's count must be this identity's next holder: the wallet and the app keep it in step. */
  #checkCount (record, count) {
    const next = (record.attributes.wallet.holderCount ?? 0) + 1
    if (count !== next) throw new Error(`the app asks for holder ${count}, but this identity's next holder is ${next}: the counts are out of step`)
  }

  /** The next counted identity key: one past the highest `authbolt-<i>` this wallet has used. */
  async #nextIdentityKeyId () {
    const records = await this.core.store.list({ type: 'AuthBOLT' })
    const used = records.map((r) => /^authbolt-(\d+)$/.exec(r.attributes?.wallet?.issuerKeyId ?? '')).filter(Boolean).map((m) => Number(m[1]))
    return `authbolt-${used.length ? Math.max(...used) + 1 : 0}`
  }

  /** Mint an AuthBOLT under `keyId`, paid by this wallet exactly (its change is 1 sat), broadcast. */
  async #mint (keyId) {
    const issuerPubKey = await this.core.publicKey(keyId)
    const issuerPkh = Hash.hash160(issuerPubKey)
    const fee = await this.#fee(keyId, (key) => buildMint({ type: 'AuthBOLT', key, issuerPubKey, issuerPkh, fund: sizingFund(issuerPkh), fee: 0 }))
    const fund = await this.core.fund(p2pkh.lock(issuerPkh), 1 + fee + 1)
    const tx = await signWith(this.core, keyId, (key) => buildMint({ type: 'AuthBOLT', key, issuerPubKey, issuerPkh, fund, fee }))
    await this.#send(tx, 'mint')
    return tx
  }

  /**
   * Move `record`'s token from its holder key to holder `n`: a commit carrying `data` and a settle,
   * each paid by one coin of the app's of exactly what it needs (no change), broadcast. The wallet's
   * record follows the token.
   */
  async #move (record, { token, n, data, funder }) {
    const wallet = record.attributes.wallet
    const from = wallet.holderKeyId
    const holderKeyId = holderKeyIdOf(wallet.issuerKeyId, n)
    const toPkh = Hash.hash160(await this.core.publicKey(holderKeyId))
    const auth = bytesOf(data)
    const measure = sizingFund(token.owner)

    const commitFee = await this.#fee(from, (key) => buildCommit({ token, key, toPkh, auth, fund: measure, fee: 0 }))
    const commitFund = await askFunder(funder, 'commit', buildCommit({ token, key: draftKey, toPkh, auth }), 1 + commitFee)
    const commit = await signWith(this.core, from, (key) => buildCommit({ token, key, toPkh, auth, fund: commitFund, fee: commitFee }))

    const settleFee = await this.#fee(from, (key) => buildSettle({ token, commit, key, toPkh, fund: measure, fee: 0 }))
    const proofInput = token.isMint ? 0 : 1 // a settle after an earlier commit also spends its 1-sat proof
    const settleFund = await askFunder(funder, 'settle', buildSettle({ token, commit, key: draftKey, toPkh }), settleFee - proofInput)
    const settle = await signWith(this.core, from, (key) => buildSettle({ token, commit, key, toPkh, fund: settleFund, fee: settleFee }))

    await this.#send(commit, 'commit')
    await this.#send(settle, 'settle')
    const moved = await this.#keep(settle, 0, 'settle', { ...wallet, holderKeyId, holderCount: n })
    await this.core.store.delete(record.id)
    return { package: [commit, settle].map((tx) => hex(toAtomicBeef(tx))), id: moved.id }
  }

  /** The identity a request is for: the one the person chose in the prompt (linked to the app
   *  here), or, silently, the one linked to the app with the keep-signed-in grant (else NEEDS_PROMPT). */
  async #chosen ({ id, domain, appPubKey, silent }) {
    if (typeof domain !== 'string' || !domain) throw new Error('a request needs the site it is for')
    if (silent) {
      const linked = (await this.forApp({ domain, appPubKey }))
        .find((t) => t.apps.some((a) => a.domain === domain && a.appPubKey === appPubKey && a.keepSignedIn))
      if (!linked) throw needsPrompt('the user has not chosen to stay signed in to this app')
      return this.#record(linked.id)
    }
    if (typeof id !== 'string' || !id) throw new Error('a prompted request needs the identity the person chose')
    const record = await this.#record(id)
    await this.#link(record, { domain, appPubKey })
    return this.#record(id)
  }

  async #signAs (keyId, { kind, appPubKey, payload }) {
    const digest = signDigest({ kind, appPubKey, payload })
    const der = lowSDer(await this.core.signDigest(keyId, digest))
    return { holder: hex(await this.core.publicKey(keyId)), signature: hex(der) }
  }

  #view (record) {
    const w = record.attributes.wallet
    return { id: record.id, type: record.type, issuer: record.issuer, keyId: w.issuerKeyId, holderKeyId: w.holderKeyId, holderCount: w.holderCount ?? 0, apps: w.apps ?? [] }
  }

  async #record (id) {
    const record = await this.core.store.get(id)
    if (!record || record.type !== 'AuthBOLT' || !record.attributes?.wallet) throw new Error(`no identity ${id} in this wallet`)
    return record
  }

  async #token (record) {
    const token = readToken(fromBeef(record.beef), record.vout ?? Number(record.id.split('.')[1] ?? 0))
    const holder = Hash.hash160(await this.core.publicKey(record.attributes.wallet.holderKeyId))
    if (hex(token.owner) !== hex(holder)) throw new Error(`identity ${record.id} is not held by its recorded key`)
    return token
  }

  async #link (record, { domain, appPubKey, keepSignedIn }) {
    const wallet = record.attributes.wallet
    const apps = [...(wallet.apps ?? [])]
    const i = apps.findIndex((a) => a.domain === domain && a.appPubKey === appPubKey)
    const was = i >= 0 ? apps[i] : { domain, appPubKey, keepSignedIn: false, linkedAt: Date.now() }
    const next = { ...was, keepSignedIn: keepSignedIn === undefined ? was.keepSignedIn : !!keepSignedIn }
    if (i >= 0) apps[i] = next; else apps.push(next)
    await this.#annotate(record, { ...wallet, apps })
  }

  async #annotate (record, wallet) {
    record.attributes = { ...record.attributes, wallet }
    if (this.core.store.annotate) await this.core.store.annotate(record.id, wallet)
    else await this.core.store.put(record)
  }

  async #keep (tx, vout, kind, wallet) {
    const token = readToken(tx, vout)
    const record = {
      id: idOf(tx, vout),
      outpoint: idOf(tx, vout),
      vout,
      type: token.type,
      issuer: hex(token.issuer),
      owner: hex(token.owner),
      status: 'held',
      amount: null,
      attributes: { wallet },
      beef: hex(toAtomicBeef(tx)),
      anchor: { txid: tx.id('hex'), kind, network: 'accepted', proven: false },
      provenance: null
    }
    await this.core.store.put(record)
    // A store that keeps the data it first stored still takes the wallet's annotation.
    if (this.core.store.annotate) await this.core.store.annotate(record.id, wallet)
    return record
  }

  async #fee (keyId, build) {
    const size = await sizeOf(this.core, keyId, build)
    return Math.max(1, Math.ceil((size * this.feePerKb) / 1000))
  }

  async #send (tx, name) {
    const sent = await this.core.broadcast(tx)
    if (sent.status === 'rejected') throw new Error(`the network refused the ${name}: ${sent.detail ?? 'no detail'}`)
    return sent.status
  }
}

/**
 * The relying party's check of a registration (or a reissue, which registers a new token for the same
 * identity). Users are the issuers, so the issuer is read from the package; the app compares it with
 * the account it has on record. The package must move the token on chain: a commit carrying this
 * app's data that spends the token's own mint (so only the issuer key could sign it), then a settle
 * to the identity's next holder, both funded and accepted by the network (re-sent here; "seen" is
 * enough: it will be mined).
 * A rotation (rotate data) is checked the same way, except that its commit must spend `outpoint`,
 * the token's outpoint the app recorded (the last verdict's `tokenId`), instead of a mint.
 * @param handler    a BoltHandler (its core's broadcaster and headers judge the package)
 * @param appPubKey  this app's key: the data must name it
 * @param data       the auth data this app issued for this challenge (hex)
 * @param outpoint   for a rotation: the token's recorded outpoint (`txid.vout`)
 * @returns `{ ok, reason? }`, and when ok `{ issuer, holder, count, tokenId, purpose, anchors, mintTxid? }`:
 *          `holder` is the new holder key's hash (its public key comes with its first signature), and
 *          `tokenId` the token's new outpoint
 */
export async function verifyIdentity ({ handler, package: pkg, appPubKey, data, outpoint }) {
  let decoded, app
  try {
    app = checkAppKey(appPubKey)
    decoded = decodeAuthData(data)
  } catch (e) {
    return { ok: false, reason: e.message }
  }
  if (decoded.appPubKey !== app) return { ok: false, reason: 'the auth data names another app' }
  const rotating = decoded.purpose === 'rotate'
  if (!rotating && !['register', 'reissue'].includes(decoded.purpose)) return { ok: false, reason: `${decoded.purpose} data does not register an identity` }
  let issuer
  try {
    const named = pkg.map((entry) => readToken(fromBeef(entry))).find(Boolean)
    if (!named) return { ok: false, reason: 'no BOLT token in the package' }
    issuer = hex(named.issuer)
  } catch (e) {
    return { ok: false, reason: `invalid package: ${e.message}` }
  }
  const mint = rotating ? spendsOutpoint(pkg, data.toLowerCase(), outpoint) : mintProvenance(pkg, data.toLowerCase())
  if (mint.reason) return { ok: false, reason: mint.reason }
  const r = await handler.verify(pkg, { issuer })
  if (!r.ok) return { ok: false, reason: r.reason }
  if (r.type !== 'AuthBOLT') return { ok: false, reason: 'not an AuthBOLT' }
  if (r.kind === 'presentation') return { ok: false, reason: 'a registration must be on chain: this move was never funded or broadcast' }
  if (r.kind !== 'transfer') return { ok: false, reason: 'a registration moves the token once (a commit and a settle)' }
  if (r.data !== data.toLowerCase()) return { ok: false, reason: 'the presentation carries other data than this challenge' }
  if (!rotating && r.issuer !== mint.issuer) return { ok: false, reason: 'the presented token\'s issuer is not its mint\'s' }
  return {
    ok: true, issuer: r.issuer, holder: r.owner, count: decoded.count, tokenId: r.tokenId, purpose: decoded.purpose,
    anchors: r.anchors, ...(rotating ? {} : { mintTxid: mint.txid })
  }
}

/**
 * A rotation's commit (the transaction whose first input carries this auth data) must spend the
 * token's recorded outpoint: the move continues the token the app knows, from the holder it knows.
 * Returns `{}` or `{ reason }`; no network.
 */
function spendsOutpoint (pkg, data, outpoint) {
  if (typeof outpoint !== 'string' || !/^[0-9a-f]{64}\.\d+$/i.test(outpoint)) return { reason: 'a rotation needs the token\'s recorded outpoint' }
  for (const entry of pkg) {
    let tx
    try { tx = fromBeef(entry) } catch { continue }
    const input = tx.inputs?.[0]
    const chunks = input?.unlockingScript?.chunks ?? []
    if (!chunks.length || hex(chunks[0].data ?? []) !== data) continue // not the commit
    const spent = `${input.sourceTXID ?? input.sourceTransaction?.id('hex')}.${input.sourceOutputIndex}`
    if (spent !== outpoint.toLowerCase()) return { reason: 'the rotation does not spend the token\'s recorded outpoint' }
    return {}
  }
  return { reason: 'the presentation carries other data than this challenge' } // no commit carries it
}

/**
 * The presented commit (the transaction whose first input carries this auth data) must spend a mint
 * the package carries. A token whose lineage never passed through a genuine mint proves no ownership
 * (audit V1); spending a mint, by contrast, needs the issuer key under the covenant's genesis guard,
 * which the full verify then executes. Returns `{ txid, issuer, signer }` or `{ reason }`; no network.
 */
function mintProvenance (pkg, data) {
  for (const entry of pkg) {
    let tx
    try { tx = fromBeef(entry) } catch { continue }
    const input = tx.inputs?.[0]
    const chunks = input?.unlockingScript?.chunks ?? []
    if (!chunks.length || hex(chunks[0].data ?? []) !== data) continue // not the commit
    const src = input.sourceTransaction
    if (!src) return { reason: 'the presentation does not carry the mint its token was spent from' }
    const txid = src.id('hex')
    if (input.sourceTXID && input.sourceTXID !== txid) return { reason: 'the presentation\'s mint does not match the outpoint its commit spends' }
    const token = readToken(src, input.sourceOutputIndex)
    if (!token?.isMint) return { reason: 'the presented token does not come straight from its mint: no proof of ownership' }
    const issuer = hex(token.issuer)
    // The key that signed the commit: a pushed 33-byte key that hashes to the mint's owner.
    const signer = chunks.map((c) => c.data ?? []).find((d) => d.length === 33 && (d[0] === 2 || d[0] === 3) && hex(Hash.hash160(d)) === hex(token.owner))
    return { txid, issuer, signer: signer ? hex(signer) : undefined }
  }
  return { reason: 'the presentation carries other data than this challenge' } // no commit carries it
}
