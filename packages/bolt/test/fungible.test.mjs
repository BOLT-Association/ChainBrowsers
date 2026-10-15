// Fungible tokens (SimpleMultiBOLT) through the handler, on the no-network pretend chain: mint with an
// amount, transfer the whole token (recipient as a 33-byte pubkey), receive, balance; a second hop that
// reconstructs the lineage from the store; and a 128-bit amount. b017 is driven with a wallet Signer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeSqliteStore } from '../src/index.js'
import { pretendChain, walletOn } from './harness.mjs'

test('mint a fungible token, see its amount and balance', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const minted = await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '1000000' })
  assert.equal(minted.type, 'SimpleMultiBOLT')
  const held = await issuer.handler.list()
  assert.equal(held.length, 1)
  assert.equal(held[0].amount, '1000000')
  assert.equal(await issuer.handler.balance(issuerKey), '1000000')
})

test('mint requires an amount; the wallet is only asked for BRC-100 methods', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  await assert.rejects(issuer.handler.mint({ type: 'SimpleMultiBOLT' }), /requires an amount/)
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '5' })
  assert.deepEqual([...new Set(issuer.calls)].filter((m) => !['getPublicKey', 'createSignature', 'getHeaderForHeight', 'createAction'].includes(m)), [])
})

test('transfer a fungible token to a user, who receives it; balances move', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey] })

  const minted = await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '1000000' })
  const userPub = (await user.handler.getKey()).publicKey // fungible recipient = 33-byte pubkey
  const { package: pkg } = await issuer.handler.transfer(minted.id, userPub)

  const got = await user.handler.receive(pkg)
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.type, 'SimpleMultiBOLT')
  assert.equal(got.owner, (await user.handler.getKey()).pubKeyHash)

  assert.equal(await issuer.handler.balance(issuerKey), '0') // left the issuer
  assert.equal(await user.handler.balance(issuerKey), '1000000')
  assert.deepEqual(await issuer.handler.list(), [])
  assert.equal((await user.handler.list())[0].amount, '1000000')
})

test('a fungible transfer needs the recipient 33-byte pubkey, not a pkh', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const minted = await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '10' })
  const pkh = (await issuer.handler.getKey()).pubKeyHash // 20 bytes
  await assert.rejects(issuer.handler.transfer(minted.id, pkh), /33-byte public key/)
})

test('a second hop reconstructs the lineage from the store and transfers onward', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey], store: nodeSqliteStore() })
  const site = walletOn(chain, { trustedIssuers: [issuerKey] })

  const minted = await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '777' })
  const pkg1 = (await issuer.handler.transfer(minted.id, (await user.handler.getKey()).publicKey)).package
  const got1 = await user.handler.receive(pkg1)
  assert.equal(got1.ok, true, got1.reason)

  // the user, holding only the stored token, transfers it onward to the site
  const pkg2 = (await user.handler.transfer(got1.tokenId, (await site.handler.getKey()).publicKey)).package
  const got2 = await site.handler.receive(pkg2)
  assert.equal(got2.ok, true, got2.reason)
  assert.equal(got2.type, 'SimpleMultiBOLT')
  assert.equal(await user.handler.balance(issuerKey), '0')
  assert.equal(await site.handler.balance(issuerKey), '777')
})

test('a 128-bit amount survives mint and store (no 64-bit truncation)', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain, { store: nodeSqliteStore() })
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const big = (2n ** 100n).toString()
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: big })
  assert.equal((await issuer.handler.list())[0].amount, big)
  assert.equal(await issuer.handler.balance(issuerKey), big)
})

test('pay part of a balance: split keeps the remainder, the recipient gets the piece', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey] })
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '1000' })

  const { package: pkg } = await issuer.handler.pay(issuerKey, '300', (await user.handler.getKey()).publicKey)
  const got = await user.handler.receive(pkg)
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.kind, 'split')
  assert.equal(got.type, 'SimpleMultiBOLT')
  assert.equal(await issuer.handler.balance(issuerKey), '700') // remainder, still spendable
  assert.equal(await user.handler.balance(issuerKey), '300')   // the paid piece
})

test('pay again from the remainder', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey] })
  const site = walletOn(chain, { trustedIssuers: [issuerKey] })
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '1000' })

  await issuer.handler.pay(issuerKey, '300', (await user.handler.getKey()).publicKey)
  const { package: pkg2 } = await issuer.handler.pay(issuerKey, '200', (await site.handler.getKey()).publicKey)
  assert.equal((await site.handler.receive(pkg2)).ok, true)
  assert.equal(await issuer.handler.balance(issuerKey), '500')
  assert.equal(await site.handler.balance(issuerKey), '200')
})

test('pay the exact balance transfers the whole token', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey] })
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '500' })

  const { package: pkg } = await issuer.handler.pay(issuerKey, '500', (await user.handler.getKey()).publicKey)
  const got = await user.handler.receive(pkg)
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.kind, 'transfer') // exact amount = whole token
  assert.equal(await issuer.handler.balance(issuerKey), '0')
  assert.deepEqual(await issuer.handler.list(), [])
  assert.equal(await user.handler.balance(issuerKey), '500')
})

test('re-spend a received split piece: pay it onward, funded by the recipient wallet', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey], store: nodeSqliteStore() })
  const merchant = walletOn(chain, { trustedIssuers: [issuerKey] })
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '1000' })

  // the issuer pays the user 400: a split piece (vout 1 of the split settle, no change of its own)
  const p1 = (await issuer.handler.pay(issuerKey, '400', (await user.handler.getKey()).publicKey)).package
  const r1 = await user.handler.receive(p1)
  assert.equal(r1.ok, true, r1.reason)
  assert.equal(r1.kind, 'split')
  assert.equal(await user.handler.balance(issuerKey), '400')

  // the user re-spends that piece: pays the merchant 150, keeps 250, funded by the user's own wallet rail
  const p2 = (await user.handler.pay(issuerKey, '150', (await merchant.handler.getKey()).publicKey)).package
  const r2 = await merchant.handler.receive(p2)
  assert.equal(r2.ok, true, r2.reason)
  assert.equal(await merchant.handler.balance(issuerKey), '150')
  assert.equal(await user.handler.balance(issuerKey), '250')
})

test('re-spend a received split piece whole: transfer it onward', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey] })
  const merchant = walletOn(chain, { trustedIssuers: [issuerKey] })
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '1000' })

  const p1 = (await issuer.handler.pay(issuerKey, '400', (await user.handler.getKey()).publicKey)).package
  const pieceId = (await user.handler.receive(p1)).tokenId

  const p2 = (await user.handler.transfer(pieceId, (await merchant.handler.getKey()).publicKey)).package
  const r2 = await merchant.handler.receive(p2)
  assert.equal(r2.ok, true, r2.reason)
  assert.equal(await merchant.handler.balance(issuerKey), '400')
  assert.equal(await user.handler.balance(issuerKey), '0')
  assert.deepEqual(await user.handler.list(), [])
})

const createActions = (w) => w.calls.filter((m) => m === 'createAction').length

test('a token the wallet owns funds its own transfers and pays: no createAction beyond the mint', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey] })
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '1000' })
  assert.equal(createActions(issuer), 1) // the mint's funding

  // pay: self-transfer (genesis) + split, both from the token's own change
  await issuer.handler.pay(issuerKey, '300', (await user.handler.getKey()).publicKey)
  assert.equal(createActions(issuer), 1)
  // and again from the remainder
  await issuer.handler.pay(issuerKey, '200', (await user.handler.getKey()).publicKey)
  assert.equal(createActions(issuer), 1)
  assert.equal(await issuer.handler.balance(issuerKey), '500')
})

test('a received split piece is wallet-funded once; its remainder self-funds after', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey] })
  const merchant = walletOn(chain, { trustedIssuers: [issuerKey] })
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '1000' })
  const p1 = (await issuer.handler.pay(issuerKey, '400', (await user.handler.getKey()).publicKey)).package
  assert.equal((await user.handler.receive(p1)).ok, true)
  assert.equal(createActions(user), 0)

  // the piece carries no change of its own: one wallet funding for its first spend
  await user.handler.pay(issuerKey, '150', (await merchant.handler.getKey()).publicKey)
  assert.equal(createActions(user), 1)
  // the remainder (vout 0 of the user's own split) carries change again: free
  await user.handler.pay(issuerKey, '100', (await merchant.handler.getKey()).publicKey)
  assert.equal(createActions(user), 1)
  assert.equal(await user.handler.balance(issuerKey), '150')
})

test('pay more than the wallet holds is refused', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '100' })
  await assert.rejects(issuer.handler.pay(issuerKey, '200', '02' + '33'.repeat(32)), /holds 100 .* not at least 200/)
  assert.equal(await issuer.handler.balance(issuerKey), '100') // nothing was spent
})

/** A user holding three tokens of one issuer: two received whole (300, 200) and one split piece (150). */
async function userWithThree (chain) {
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey], store: nodeSqliteStore() })
  const userPub = (await user.handler.getKey()).publicKey
  for (const amount of ['300', '200']) {
    const { id } = await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount })
    assert.equal((await user.handler.receive((await issuer.handler.transfer(id, userPub)).package)).ok, true)
  }
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '1000' })
  assert.equal((await user.handler.receive((await issuer.handler.pay(issuerKey, '150', userPub)).package)).ok, true)
  assert.equal(await user.handler.balance(issuerKey), '650')
  return { issuer, issuerKey, user }
}

test('pay across tokens: merges held tokens when no single one covers the amount', async () => {
  const chain = pretendChain()
  const { issuerKey, user } = await userWithThree(chain)
  const merchant = walletOn(chain, { trustedIssuers: [issuerKey] })

  // 400 > the largest single token (300): merge 300 + 200, split 400 off, keep 100
  const pkg = (await user.handler.pay(issuerKey, '400', (await merchant.handler.getKey()).publicKey)).package
  const got = await merchant.handler.receive(pkg)
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.kind, 'split')
  assert.equal(await merchant.handler.balance(issuerKey), '400')
  assert.equal(await user.handler.balance(issuerKey), '250')
  assert.deepEqual((await user.handler.list()).map((r) => r.amount).sort(), ['100', '150'])
})

test('pay the whole balance: merges every token (a split piece included) and transfers the lot', async () => {
  const chain = pretendChain()
  const { issuerKey, user } = await userWithThree(chain)
  const merchant = walletOn(chain, { trustedIssuers: [issuerKey] })

  const pkg = (await user.handler.pay(issuerKey, '650', (await merchant.handler.getKey()).publicKey)).package
  const got = await merchant.handler.receive(pkg)
  assert.equal(got.ok, true, got.reason)
  assert.equal(got.kind, 'transfer')
  assert.equal(await merchant.handler.balance(issuerKey), '650')
  assert.deepEqual(await user.handler.list(), [])
  // the merchant can spend the merged token onward
  const back = (await merchant.handler.pay(issuerKey, '50', (await user.handler.getKey()).publicKey)).package
  assert.equal((await user.handler.receive(back)).ok, true)
  assert.equal(await merchant.handler.balance(issuerKey), '600')
})

test('merging two freshly minted tokens (no grandparent yet) self-transfers them first', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey] })
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '60' })
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '70' })

  const pkg = (await issuer.handler.pay(issuerKey, '100', (await user.handler.getKey()).publicKey)).package
  assert.equal((await user.handler.receive(pkg)).ok, true)
  assert.equal(await user.handler.balance(issuerKey), '100')
  assert.equal(await issuer.handler.balance(issuerKey), '30')
})

test('melt a fungible token: it leaves the wallet and its satoshis return', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const { id } = await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '500' })
  const { txid } = await issuer.handler.melt(id)
  assert.match(txid, /^[0-9a-f]{64}$/)
  assert.ok(chain.seen.has(txid), 'the melt is on the network')
  assert.deepEqual(await issuer.handler.list(), [])
  assert.equal(await issuer.handler.balance(issuerKey), '0')
})

test('melt a received split piece (no change of its own): self-transferred, then melted', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const issuerKey = (await issuer.handler.getKey()).publicKey
  const user = walletOn(chain, { trustedIssuers: [issuerKey] })
  await issuer.handler.mint({ type: 'SimpleMultiBOLT', amount: '1000' })
  const piece = await user.handler.receive((await issuer.handler.pay(issuerKey, '400', (await user.handler.getKey()).publicKey)).package)
  const { txid } = await user.handler.melt(piece.tokenId)
  assert.ok(chain.seen.has(txid))
  assert.equal(await user.handler.balance(issuerKey), '0')
})

test('melt refuses an NFT', async () => {
  const chain = pretendChain()
  const issuer = walletOn(chain)
  const { id } = await issuer.handler.mint({ type: 'AuthBOLT' })
  await assert.rejects(issuer.handler.melt(id), /not a fungible/)
})
