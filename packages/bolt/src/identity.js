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
//   { issuerKeyId, holderKeyId, apps: [{ domain, appPubKey, keepSignedIn, linkedAt, signKeyId, signSeq, pending }] }
// `keepSignedIn` is the user's grant for silent keep-alive presentations to that app on that site.
//
// Holder-key signatures (PeerLoop's V1 plan). A presentation proves ownership only when its commit
// spends the token's own mint, which needs the issuer key (b017's genesis guard), so an app takes a
// presentation only to register, and records the key the identity signs with afterwards: at first
// the issuer key, then a per-app signing key (`signKeyId`) the wallet rotates to so the issuer key can
// stay offline. Sign-in, keep-alives and writes are that key's signatures over
//   sha256("PeerLoop/1\n" ‖ kind ‖ "\n" ‖ app key (33 bytes) ‖ sha256(payload))
// which the wallet builds itself (signDigest) and never takes from a page. A rotation is signed by the
// current signing key, a recovery by the issuer key; `signSeq` counts them, as the app does.
//
// Imports nothing from Node, so it bundles for the browser's trusted UI.
import { Hash, P2PKH, Random, Transaction, Utils } from '@bsv/sdk'
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
    if (decoded.purpose === 'register' && !(await this.#token(record)).isMint) {
      throw new Error('this identity\'s token has moved since its mint, so it proves no ownership: it cannot register')
    }
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

  /**
   * Sign `payload` as `kind` for an app with the identity's signing key (holder key). Silent (no
   * prompt shown) only under the keep-signed-in grant for that app on that site, and only for
   * sign-in, keep-alive and the writes the app's published tiers call silent; anything else throws
   * NEEDS_PROMPT. Behind the wallet's prompt (`silent` false) the person chose the identity `id`.
   * @returns `{ identity, holder, signature }`: the issuer key, the signing key and DER hex
   */
  async sign ({ id, domain, appPubKey, kind, payload, silent }) {
    const app = checkAppKey(appPubKey)
    if (!['signin', 'refresh', 'write'].includes(kind)) throw new Error(`a page may ask to sign signin, refresh or write, not ${kind}: rotate and recover are the wallet's own`)
    if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD) throw new Error('the payload must be text of at most 64 KiB')
    const tier = kind === 'write' ? tierOfWrite(payload) : 'silent'
    if (silent && tier !== 'silent') {
      await this.#chosen({ domain, appPubKey: app, silent }) // no grant reads as no grant first
      throw needsPrompt('the wallet always asks before signing this change')
    }
    const record = await this.#chosen({ id, domain, appPubKey: app, silent })
    const entry = this.#app(record, domain, app)
    const keyId = entry.signKeyId ?? record.attributes.wallet.issuerKeyId
    return { identity: record.issuer, ...(await this.#signAs(keyId, { kind, appPubKey: app, payload })) }
  }

  /**
   * Move an identity's signing key for one app to a new key: the current signing key signs
   * `{"issuer","newHolder","seq"}`. The new key is used once the app accepted it (confirmHolder).
   * @returns `{ issuer, newHolder, seq, signature }` for the app's rotate request
   */
  async rotateHolder ({ id, domain, appPubKey }) {
    const app = checkAppKey(appPubKey)
    const record = await this.#record(id)
    const entry = this.#app(record, domain, app)
    const keyId = this.newKeyId()
    const newHolder = hex(await this.core.publicKey(keyId))
    const seq = (entry.signSeq ?? 0) + 1
    const payload = `{"issuer":"${record.issuer}","newHolder":"${newHolder}","seq":${seq}}`
    const { signature } = await this.#signAs(entry.signKeyId ?? record.attributes.wallet.issuerKeyId, { kind: 'rotate', appPubKey: app, payload })
    await this.#setApp(record, domain, app, { pending: { keyId, seq } })
    return { issuer: record.issuer, newHolder, seq, signature }
  }

  /**
   * Rebind an identity for one app to a new signing key with the issuer key, over the app's fresh
   * challenge: `{"issuer","newHolder","seq","challenge"}`. For a lost signing key; `seq` defaults
   * to one past the wallet's count. Takes effect with confirmHolder.
   */
  async recoverHolder ({ id, domain, appPubKey, challenge, seq }) {
    const app = checkAppKey(appPubKey)
    if (typeof challenge !== 'string' || !/^[0-9a-f]{2,264}$/i.test(challenge)) throw new Error('a recovery signs the app\'s challenge (hex)')
    const record = await this.#record(id)
    const entry = this.#app(record, domain, app)
    const keyId = this.newKeyId()
    const newHolder = hex(await this.core.publicKey(keyId))
    const n = seq ?? (entry.signSeq ?? 0) + 1
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('seq counts up from 1')
    const payload = `{"issuer":"${record.issuer}","newHolder":"${newHolder}","seq":${n},"challenge":"${challenge}"}`
    const { signature } = await this.#signAs(record.attributes.wallet.issuerKeyId, { kind: 'recover', appPubKey: app, payload })
    await this.#setApp(record, domain, app, { pending: { keyId, seq: n } })
    return { issuer: record.issuer, newHolder, seq: n, signature }
  }

  /** The app accepted the last rotation or recovery: sign with the new key from now on. */
  async confirmHolder ({ id, domain, appPubKey }) {
    const app = checkAppKey(appPubKey)
    const record = await this.#record(id)
    const { pending } = this.#app(record, domain, app)
    if (!pending) throw new Error('no rotation is waiting for this app')
    await this.#setApp(record, domain, app, { signKeyId: pending.keyId, signSeq: pending.seq, pending: undefined })
  }

  /**
   * Answer a page's request (Hodos POST /bolt/sign) by kind: signin, refresh and write are
   * signatures (sign); rotate prepares a move of the app's signing key and confirm makes it take
   * effect, silently only under the keep-signed-in grant; recover uses the issuer key and is never
   * silent. The page learns the signature and public keys, never anything else.
   */
  async answer ({ id, domain, appPubKey, kind, payload, silent, seq }) {
    const app = checkAppKey(appPubKey)
    switch (kind) {
      case 'signin': case 'refresh': case 'write':
        return this.sign({ id, domain, appPubKey: app, kind, payload, silent })
      case 'rotate': {
        const record = await this.#chosen({ id, domain, appPubKey: app, silent })
        const r = await this.rotateHolder({ id: record.id, domain, appPubKey: app })
        return { identity: r.issuer, newHolder: r.newHolder, seq: r.seq, signature: r.signature }
      }
      case 'confirm': {
        const record = await this.#chosen({ id, domain, appPubKey: app, silent })
        await this.confirmHolder({ id: record.id, domain, appPubKey: app })
        const entry = this.#app(await this.#record(record.id), domain, app)
        return { identity: record.issuer, holder: hex(await this.core.publicKey(entry.signKeyId)), seq: entry.signSeq }
      }
      case 'recover': {
        if (silent) throw needsPrompt('the wallet always asks before a recovery')
        const record = await this.#chosen({ id, domain, appPubKey: app, silent })
        const r = await this.recoverHolder({ id: record.id, domain, appPubKey: app, challenge: payload, seq })
        return { identity: r.issuer, newHolder: r.newHolder, seq: r.seq, signature: r.signature }
      }
      default:
        throw new Error(`unknown kind ${kind}: signin, refresh, write, rotate, confirm or recover`)
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

  /** The identity's link to an app on a site; throws when there is none. */
  #app (record, domain, appPubKey) {
    const entry = (record.attributes.wallet.apps ?? []).find((a) => a.domain === domain && a.appPubKey === appPubKey)
    if (!entry) throw new Error('this identity is not linked to that app on that site')
    return entry
  }

  async #setApp (record, domain, appPubKey, change) {
    const wallet = record.attributes.wallet
    const apps = (wallet.apps ?? []).map((a) => {
      if (a.domain !== domain || a.appPubKey !== appPubKey) return a
      const next = { ...a, ...change }
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
      return next
    })
    await this.#annotate(record, { ...wallet, apps })
  }

  async #signAs (keyId, { kind, appPubKey, payload }) {
    const digest = signDigest({ kind, appPubKey, payload })
    const der = lowSDer(await this.core.signDigest(keyId, digest))
    return { holder: hex(await this.core.publicKey(keyId)), signature: hex(der) }
  }

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
  const mint = mintProvenance(pkg, data.toLowerCase())
  if (mint.reason) return { ok: false, reason: mint.reason }
  const r = await handler.verify(pkg, { issuer })
  if (!r.ok) return { ok: false, reason: r.reason }
  if (r.kind !== 'presentation' || r.type !== 'AuthBOLT') return { ok: false, reason: 'not an AuthBOLT presentation' }
  if (r.data !== data.toLowerCase()) return { ok: false, reason: 'the presentation carries other data than this challenge' }
  if (r.owner !== r.holder) return { ok: false, reason: 'a presentation must be a self-transfer: it moves the token to another key' }
  if (r.issuer !== mint.issuer) return { ok: false, reason: 'the presented token\'s issuer is not its mint\'s' }
  return {
    ok: true, issuer: r.issuer, holder: r.holder, tokenId: r.tokenId, purpose: decoded.purpose, anchors: r.anchors,
    mintTxid: mint.txid, holderPubKey: mint.signer
  }
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
