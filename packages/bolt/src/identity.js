// AuthBOLT identities: the wallet side and the relying party's check.
//
// A user is the issuer of their own AuthBOLTs and an app is a verifier. Each identity is one AuthBOLT
// minted under its own key (BRC-43 protocol IDENTITY_PROTOCOL, a keyID kept with the token), so two
// identities share nothing an app could link. The token only ever moves to its holder's own new key
// (`rotate`): the holder pubKeyHash may change, the issuer key never does, and the issuer key is what
// an app records as the account.
//
// The wallet presents an identity only with AUTH DATA that names the app asking (66 bytes):
//   [tag 1][app public key 33][challenge hash 32]
// tag 0x01 register, 0x02 sign in, 0x03 keep a session alive, 0x04 a write (one change a person makes in the
// app, signed: the hash is the write's own). The app's server makes the data from
// its own challenge; the wallet reads the tag and the app key to word its prompt, and refuses data
// that names another app. A presentation is a self-transfer: the settle pays the holder's own key,
// and the app key is bound by the auth data the commit carries and the settle covers. So it is no use
// to any other verifier (the data names this app and this challenge), and it never hands the token
// to the app.
//
// What the wallet remembers about an identity lives in the token row's attributes, under `wallet`:
//   { issuerKeyId, holderKeyId, apps: [{ domain, appPubKey, keepSignedIn, linkedAt }] }
// `keepSignedIn` is the user's grant for silent keep-alive presentations to that app on that site.
//
// Imports nothing from Node, so it bundles for the browser's trusted UI.
import { Hash, P2PKH, Random, Transaction, Utils } from '@bsv/sdk'
import { fromBeef, toAtomicBeef } from 'b017'
import { buildCommit, buildMint, buildSettle, readToken } from './nft.js'
import { signWith, sizeOf } from './signer.js'

/** The BRC-43 protocol identity keys are derived under: level 2 (per counterparty), its own name, so a
 *  wallet can refuse it to sites and keep identity signing to its own prompt. */
export const IDENTITY_PROTOCOL = [2, 'authbolt identity']
export const AUTH_DATA_BYTES = 66
const PURPOSES = { register: 1, signin: 2, refresh: 3, write: 4 }
/** The purposes a wallet presents without asking, under the person's keep-signed-in grant. */
const SILENT = ['refresh', 'write']
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

/** Auth data for a presentation (hex). */
export function encodeAuthData ({ purpose, appPubKey, challengeHash }) {
  const tag = PURPOSES[purpose]
  if (!tag) throw new Error(`unknown purpose ${purpose}: register, signin, refresh or write`)
  if (!isHex(challengeHash, 64)) throw new Error('the challenge hash must be 32 bytes (hex)')
  return (tag.toString(16).padStart(2, '0') + checkAppKey(appPubKey) + challengeHash).toLowerCase()
}

/** Read auth data; throws on anything that is not exactly that. */
export function decodeAuthData (data) {
  const s = typeof data === 'string' ? data.toLowerCase() : hex(data)
  if (!isHex(s, AUTH_DATA_BYTES * 2)) throw new Error(`auth data must be exactly ${AUTH_DATA_BYTES} bytes (hex)`)
  const purpose = PURPOSE_OF[parseInt(s.slice(0, 2), 16)]
  if (!purpose) throw new Error(`unknown purpose tag 0x${s.slice(0, 2)}`)
  let appPubKey
  try { appPubKey = checkAppKey(s.slice(2, 68)) } catch { throw new Error('the auth data does not carry a valid app key') }
  return { purpose, appPubKey, challengeHash: s.slice(68) }
}

/** An error the browser answers by showing its prompt instead of presenting silently. */
function needsPrompt (why) {
  return Object.assign(new Error(why), { code: 'NEEDS_PROMPT' })
}

/** A stand-in funding output of the right shape, to measure a transaction before funding it. */
const sizingFund = (pkh) => ({ tx: new Transaction(1, [], [{ satoshis: 1e8, lockingScript: p2pkh.lock(pkh) }], 0), vout: 0 })

export class IdentityWallet {
  /**
   * @param core       a wallet core whose keys are derived under IDENTITY_PROTOCOL (brc100Core with
   *                   `protocolID: IDENTITY_PROTOCOL`); its store must have `annotate` or `get`+`put`
   * @param feePerKb   satoshis per 1000 bytes for the funded transactions (mint, rotate)
   * @param newKeyId   a fresh keyID for each identity key
   */
  constructor ({ core, feePerKb = 100, newKeyId = () => `authbolt-${hex(Random(16))}` }) {
    this.core = core
    this.feePerKb = feePerKb
    this.newKeyId = newKeyId
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

  /** Mint a new identity under a new key. Funded exactly, so its change is 1 sat. */
  async create () {
    const keyId = this.newKeyId()
    const issuerPubKey = await this.core.publicKey(keyId)
    const issuerPkh = Hash.hash160(issuerPubKey)
    const fee = await this.#fee(keyId, (key) => buildMint({ type: 'AuthBOLT', key, issuerPubKey, issuerPkh, fund: sizingFund(issuerPkh), fee: 0 }))
    const fund = await this.core.fund(p2pkh.lock(issuerPkh), 1 + fee + 1)
    const tx = await signWith(this.core, keyId, (key) => buildMint({ type: 'AuthBOLT', key, issuerPubKey, issuerPkh, fund, fee }))
    await this.#send(tx, 'mint')
    const record = await this.#keep(tx, 0, 'mint', { issuerKeyId: keyId, holderKeyId: keyId, apps: [] })
    return this.#view(record)
  }

  /**
   * Present identity `id` to an app: the data must name that app. Links the identity to the app on
   * this site, and records the user's keep-signed-in choice when one is given. Nothing is broadcast.
   * @returns `{ package, id }` for the app's server
   */
  async present ({ id, domain, appPubKey, data, keepSignedIn }) {
    const app = checkAppKey(appPubKey)
    const decoded = decodeAuthData(data)
    if (decoded.purpose === 'write') throw new Error('a write is only ever signed silently, under the keep-signed-in grant')
    if (decoded.appPubKey !== app) throw new Error('the auth data names another app than the one asking')
    if (typeof domain !== 'string' || !domain) throw new Error('a presentation needs the site it is for')
    const record = await this.#record(id)
    const pkg = await this.#presentation(record, app, data)
    await this.#link(record, { domain, appPubKey: app, keepSignedIn })
    return { package: pkg, id }
  }

  /**
   * A presentation without asking: only keep-alive or write data, only to an app on a site the user
   * chose to stay signed in to. Anything else throws NEEDS_PROMPT (or a plain error for wrong data).
   */
  async refresh ({ domain, appPubKey, data }) {
    const app = checkAppKey(appPubKey)
    const decoded = decodeAuthData(data)
    if (!SILENT.includes(decoded.purpose)) throw new Error('only keep-alive or write data can be presented without asking')
    if (decoded.appPubKey !== app) throw new Error('the auth data names another app than the one asking')
    const linked = (await this.forApp({ domain, appPubKey: app }))
      .find((t) => t.apps.some((a) => a.domain === domain && a.appPubKey === app && a.keepSignedIn))
    if (!linked) throw needsPrompt('the user has not chosen to stay signed in to this app')
    const record = await this.#record(linked.id)
    return { package: await this.#presentation(record, app, data), id: linked.id }
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

  /** Move the identity to a new holder key of this wallet (a funded commit and settle, broadcast).
   *  The issuer key, and so the identity apps know, stays. */
  async rotate (id) {
    const record = await this.#record(id)
    const wallet = record.attributes.wallet
    const token = await this.#token(record)
    const holderKeyId = this.newKeyId()
    const toPkh = Hash.hash160(await this.core.publicKey(holderKeyId))
    const from = wallet.holderKeyId

    // Measure both with stand-in funding, then fund the commit with exactly what both need: the
    // commit's change funds the settle, and the settle's change is 1 sat.
    const fake = sizingFund(token.owner)
    const commitFee = await this.#fee(from, (key) => buildCommit({ token, key, toPkh, fund: fake, fee: 0 }))
    const fakeCommit = await signWith(this.core, from, (key) => buildCommit({ token, key, toPkh, fund: fake, fee: commitFee }))
    const settleFee = await this.#fee(from, (key) => buildSettle({ token, commit: fakeCommit, key, toPkh, fund: { tx: fakeCommit, vout: fakeCommit.outputs.length - 1 }, fee: 0 }))
    const proofInput = token.isMint ? 0 : 1
    const fund = await this.core.fund(p2pkh.lock(token.owner), 1 + commitFee + (1 + settleFee - proofInput))

    const commit = await signWith(this.core, from, (key) => buildCommit({ token, key, toPkh, fund, fee: commitFee }))
    const change = { tx: commit, vout: commit.outputs.length - 1 }
    const settle = await signWith(this.core, from, (key) => buildSettle({ token, commit, key, toPkh, fund: change, fee: settleFee }))
    await this.#send(commit, 'commit')
    await this.#send(settle, 'settle')
    const moved = await this.#keep(settle, 0, 'settle', { ...wallet, holderKeyId })
    await this.core.store.delete(id)
    return this.#view(moved)
  }

  // ---- inside ----------------------------------------------------------------------

  #view (record) {
    const w = record.attributes.wallet
    return { id: record.id, type: record.type, issuer: record.issuer, keyId: w.issuerKeyId, holderKeyId: w.holderKeyId, apps: w.apps ?? [] }
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

  async #presentation (record, app, data) {
    const token = await this.#token(record)
    const keyId = record.attributes.wallet.holderKeyId
    const toPkh = token.owner // a self-transfer; the app is named in the auth data
    const auth = bytesOf(data)
    const commit = await signWith(this.core, keyId, (key) => buildCommit({ token, key, toPkh, auth }))
    const settle = await signWith(this.core, keyId, (key) => buildSettle({ token, commit, key, toPkh }))
    return [commit, settle].map((tx) => hex(toAtomicBeef(tx)))
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
 * The relying party's check of an identity presentation. Users are the issuers, so the issuer is
 * read from the package; the app compares it with the account it has on record.
 * @param handler    a BoltHandler (its core's broadcaster and headers judge the anchor)
 * @param appPubKey  this app's key: the data must name it (the presentation is a self-transfer)
 * @param data       the auth data this app issued for this challenge (hex)
 * @returns `{ ok, reason? }`, and when ok `{ issuer, holder, tokenId, purpose, anchors }`
 */
export async function verifyIdentity ({ handler, package: pkg, appPubKey, data }) {
  let decoded, app
  try {
    app = checkAppKey(appPubKey)
    decoded = decodeAuthData(data)
  } catch (e) {
    return { ok: false, reason: e.message }
  }
  if (decoded.appPubKey !== app) return { ok: false, reason: 'the auth data names another app' }
  let issuer
  try {
    const named = pkg.map((entry) => readToken(fromBeef(entry))).find(Boolean)
    if (!named) return { ok: false, reason: 'no BOLT token in the package' }
    issuer = hex(named.issuer)
  } catch (e) {
    return { ok: false, reason: `invalid package: ${e.message}` }
  }
  const r = await handler.verify(pkg, { issuer })
  if (!r.ok) return { ok: false, reason: r.reason }
  if (r.kind !== 'presentation' || r.type !== 'AuthBOLT') return { ok: false, reason: 'not an AuthBOLT presentation' }
  if (r.data !== data.toLowerCase()) return { ok: false, reason: 'the presentation carries other data than this challenge' }
  if (r.owner !== r.holder) return { ok: false, reason: 'a presentation must be a self-transfer: it moves the token to another key' }
  return { ok: true, issuer: r.issuer, holder: r.holder, tokenId: r.tokenId, purpose: decoded.purpose, anchors: r.anchors }
}
