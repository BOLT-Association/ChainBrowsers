// Live: window.BOLT in a page in the bsv-browser app (the Android emulator), spv mode on Arcade.
//
//   page  = tests/cross-wallet/page (http://localhost:8095/?role=bsv, through `adb reverse`), in the
//           app's WebView. It has only the thin window.BOLT; the handler, the keys, the tokens
//           (SQLite) and the prompt are the app's.
//   site, user = handlers in this process on plain keys, talking to Arcade themselves: the other
//           party, who only ever sees the packages the page hands out
//
// The page mints an AuthBOLT and presents it, mints a fungible token and pays part of it, and one
// request is declined. Each request that asks shows the app's prompt, which this test reads from
// the screen (it must name the operation) and answers as a person would, by tapping.
//
//   .\e2e.ps1 -NoTest -RestartMetro     (stack, emulator, Metro and the app; from the repo root)
//   node live/bsv-page.live.mjs
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Hash, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { BoltHandler, PAGE_METHODS, brc100Core } from '../src/index.js'
import * as chain from '../../../tests/hodos-spv/lib.mjs' // funding: its own SDK copy, kept to itself
import { startRelay } from '../../../tests/cross-wallet/server.mjs'
import { adb, openUrl, screen, screenshot, watchToast } from '../../../tests/cross-wallet/emulator.mjs'

const ARCADE = process.env.ARCADE_URL ?? 'http://localhost:8080'
const BSV = 'bsv'
const OUT = fileURLToPath(new URL('../../../tests/cross-wallet/out/bolt-bsv/', import.meta.url))
const step = (m) => console.log('ok  ', m)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
mkdirSync(OUT, { recursive: true })

const relay = await startRelay()
const cwi = (method, args) => relay.call(BSV, method, args, { quiet: true })
const bolt = (method, ...args) => relay.call(BSV, `BOLT.${method}`, args, { timeout: 240000 })

/**
 * Answer the app's prompt as a person would. Waits for a prompt whose text matches `expect`, saves a
 * screenshot of it, and taps `button`. Returns the prompt's text.
 */
async function answer (expect, button = 'Approve', shot) {
  for (let i = 0; i < 60; i++) {
    const nodes = screen()
    const text = nodes.map((n) => n.text).filter(Boolean).join(' | ')
    const target = nodes.find((n) => n.text === button)
    if (target && expect.test(text)) {
      if (shot) screenshot(`${OUT}${shot}.png`)
      adb('shell', 'input', 'tap', String(target.x), String(target.y))
      return text
    }
    await sleep(700)
  }
  throw new Error(`no prompt matching ${expect} with a "${button}" button appeared`)
}
/** Make a BOLT request that asks, and answer its prompt. */
async function asking (expect, method, args, { button = 'Approve', shot } = {}) {
  const pending = bolt(method, ...args)
  pending.catch(() => {}) // observed below; do not let a decline be an unhandled rejection meanwhile
  const prompt = await answer(expect, button, shot)
  return { value: await pending.catch((e) => { if (button === 'Approve') throw e; return e }), prompt }
}

/** The other party: plain keys, Arcade for the network. It holds no headers: what a package rests
 *  on is checked with the network. */
const party = (trustedIssuers) => {
  const proto = new ProtoWallet(PrivateKey.fromRandom())
  const wallet = {
    getPublicKey: (a) => proto.getPublicKey(a),
    createSignature: (a) => proto.createSignature(a),
    getHeaderForHeight: async () => { throw new Error('this party keeps no headers') }
  }
  return new BoltHandler({ core: brc100Core({ wallet, arcadeUrl: ARCADE }), trustedIssuers })
}

/** Give the app's wallet coins: a coinbase spend to a BRC-29 key of the wallet, mined, handed over
 *  as a BEEF through the page (as tests/cross-wallet/run.mjs does). */
async function fund (satoshis) {
  const { PrivateKey, PublicKey, P2PKH, MerklePath, Utils } = chain
  const id = (await cwi('getPublicKey', { identityKey: true })).publicKey
  const sender = PrivateKey.fromRandom()
  const rnd = () => Utils.toBase64(Utils.toArray(Math.random().toString(36).slice(2, 10), 'utf8'))
  const [prefix, suffix] = [rnd(), rnd()]
  const child = PublicKey.fromString(id).deriveChild(sender, `2-3241645161d8-${prefix} ${suffix}`)
  const tx = await chain.spendCoinbase([{ lockingScript: new P2PKH().lock(child.toHash()), satoshis }])
  const st = await chain.mineUntilMined(tx.id('hex'), { settle: 1000, wait: 6000, every: 500, tries: 20 })
  tx.merklePath = MerklePath.fromHex(st.merklePath)
  await chain.until(`the app's header chain reaches ${st.blockHeight}`,
    async () => ((await cwi('getHeight', {}).catch(() => ({ height: 0 }))).height >= st.blockHeight), { timeout: 180000, every: 1500 })
  await cwi('internalizeAction', {
    tx: tx.toAtomicBEEF(),
    outputs: [{ outputIndex: 0, protocol: 'wallet payment', paymentRemittance: { senderIdentityKey: sender.toPublicKey().toString(), derivationPrefix: prefix, derivationSuffix: suffix } }],
    description: 'BOLT test funding',
    labels: ['bolt-live']
  })
  return st.blockHeight
}

const stopToasts = watchToast()
try {
  adb('reverse', `tcp:${relay.port}`, `tcp:${relay.port}`)
  openUrl(`http://localhost:${relay.port}/?role=${BSV}`)
  await chain.until('the page in the app to connect', async () => relay.connected(BSV), { timeout: 120000, every: 1000 })
  step('the test page is open in the app')

  const key = await bolt('getKey')
  assert.equal(key.pubKeyHash, Utils.toHex(Hash.hash160(Utils.toArray(key.publicKey, 'hex'))))
  step(`window.BOLT.getKey() from the page: ${key.publicKey.slice(0, 16)}… (no prompt)`)
  assert.deepEqual((await bolt('list')).map((r) => typeof r.id), (await bolt('list')).map(() => 'string'))

  const height = await fund(200_000)
  step(`the app's wallet was funded (block ${height})`)

  // --- AuthBOLT: mint, then present to a site that checks it independently ---
  const mint = await asking(/localhost asks to.*mint a new AuthBOLT token/i, 'mint', [{ type: 'AuthBOLT' }], { shot: 'prompt-mint' })
  assert.match(mint.value.id, /^[0-9a-f]{64}\.0$/)
  step(`the app asked "${mint.prompt.match(/localhost asks to[^|]*\| [^|]*/i)?.[0] ?? mint.prompt.slice(0, 90)}" and, approved, minted ${mint.value.id.slice(0, 16)}…`)

  const challenge = Utils.toHex(Hash.sha256(Utils.toArray(`login ${Date.now()}`, 'utf8')))
  const shown = await asking(/show token [0-9a-f]{8} to this site with the data/i, 'present', [mint.value.id, { data: challenge }])
  const site = party([key.publicKey])
  const verdict = await site.verify(shown.value.package)
  assert.equal(verdict.ok, true, verdict.reason)
  assert.equal(verdict.kind, 'presentation')
  assert.equal(verdict.data, challenge)
  step('a site outside the app verified the presentation and its challenge')

  // --- fungible: mint 1000, pay 300 to a user outside the app ---
  const before = (await bolt('list')).filter((r) => r.type === 'SimpleMultiBOLT' && r.issuer === key.publicKey).reduce((s, r) => s + BigInt(r.amount), 0n)
  await asking(/mint a new SimpleMultiBOLT token of 1000/i, 'mint', [{ type: 'SimpleMultiBOLT', amount: '1000' }])
  const user = party([key.publicKey])
  const userPub = (await user.getKey()).publicKey
  const paid = await asking(/pay 300 of token/i, 'pay', [key.publicKey, '300', userPub], { shot: 'prompt-pay' })
  const got = await user.receive(paid.value.package)
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.kind, 'split')
  assert.equal(await user.balance(key.publicKey), '300')
  const after = (await bolt('list')).filter((r) => r.type === 'SimpleMultiBOLT' && r.issuer === key.publicKey).reduce((s, r) => s + BigInt(r.amount), 0n)
  assert.equal(after, before + 700n)
  step('the page minted 1000 and paid 300 by split; a user outside the app received it; the app keeps 700')

  // --- declined: nothing happens ---
  const held = (await bolt('list')).length
  const refused = await asking(/melt \(destroy\) token/i, 'melt', [mint.value.id], { button: 'Decline' })
  assert.match(String(refused.value.message), /BOLT: the user declined/)
  assert.equal((await bolt('list')).length, held)
  step('a declined request was refused and changed nothing')

  assert.deepEqual(Object.keys(PAGE_METHODS).length, 9)
  console.log(`screenshots of the prompts: ${OUT}`)
  console.log('PASS window.BOLT in the bsv-browser app')
} finally {
  stopToasts()
  await relay.close()
}
