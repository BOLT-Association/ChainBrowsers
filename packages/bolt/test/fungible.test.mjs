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
