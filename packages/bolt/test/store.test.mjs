// The type-agnostic token store: one contract run against both backends (the in-memory store and the
// node:sqlite store), plus sqlite-specific checks for 128-bit amounts, balance aggregation, the
// spent/proof lifecycle, and persistence across a reopen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryStore } from '../src/core.js'
import { nodeSqliteStore } from '../src/store-node.js'

const ISS = '02' + '11'.repeat(32)
const sample = (over = {}) => ({
  id: 'ab'.repeat(32) + '.0',
  vout: 0,
  type: 'FutureBOLT', // a type the code has never heard of: the store must not care
  issuer: ISS,
  owner: 'cc'.repeat(20),
  status: 'held',
  amount: null,
  attributes: { note: 'x', nested: { a: 1 } },
  beef: 'deadbeef',
  anchor: { txid: 'ab'.repeat(32), kind: 'settle', network: 'accepted', proven: true, height: 7, merkleRoot: 'ef'.repeat(32) },
  provenance: { txid: 'cd'.repeat(32), kind: 'mint', status: 'already-seen' },
  ...over
})

async function contract (name, make) {
  await test(`store contract: ${name}`, async () => {
    const store = make()
    const rec = sample()
    await store.put(rec)

    const got = await store.get(rec.id)
    assert.equal(got.type, 'FutureBOLT') // type-agnostic: an unknown type round-trips
    assert.equal(got.issuer, ISS)
    assert.equal(got.owner, rec.owner)
    assert.equal(got.beef, 'deadbeef')
    assert.equal(got.vout, 0)
    // everything we know about the anchor survives
    assert.equal(got.anchor.kind, 'settle')
    assert.equal(got.anchor.network, 'accepted')
    assert.equal(got.anchor.proven, true)
    assert.equal(got.anchor.height, 7)
    assert.equal(got.anchor.merkleRoot, 'ef'.repeat(32))
    assert.equal(got.provenance.kind, 'mint')
    assert.equal(got.provenance.txid, 'cd'.repeat(32))
    assert.deepEqual(got.attributes, { note: 'x', nested: { a: 1 } })

    assert.equal((await store.list()).length, 1)
    await store.delete(rec.id)
    assert.equal(await store.get(rec.id), undefined)
    assert.equal((await store.list()).length, 0)
    store.close?.()
  })
}

await contract('memoryStore', () => memoryStore())
await contract('nodeSqliteStore(:memory:)', () => nodeSqliteStore())

test('sqlite: 128-bit fungible amounts survive and balance aggregates them', async () => {
  const store = nodeSqliteStore()
  const big = (2n ** 100n).toString()
  await store.put(sample({ id: 'a'.repeat(64) + '.0', type: 'SimpleMultiBOLT', amount: big }))
  await store.put(sample({ id: 'b'.repeat(64) + '.0', type: 'SimpleMultiBOLT', amount: '5' }))
  const one = await store.get('a'.repeat(64) + '.0')
  assert.equal(one.amount, big) // a decimal string, not a truncated 64-bit INTEGER
  assert.equal(await store.balance(ISS, 'SimpleMultiBOLT'), (2n ** 100n + 5n).toString())
  store.close()
})

test('sqlite: markSpent drops a token from the held list but keeps the row; setAnchorProof updates the proof', async () => {
  const store = nodeSqliteStore()
  await store.put(sample())
  await store.markSpent(sample().id)
  assert.equal((await store.list()).length, 0) // not held any more
  assert.equal((await store.get(sample().id)).status, 'spent') // but still on record

  await store.put(sample({ id: 'ff'.repeat(32) + '.0', anchor: { ...sample().anchor, proven: false, height: undefined, merkleRoot: undefined } }))
  assert.equal((await store.get('ff'.repeat(32) + '.0')).anchor.proven, false)
  await store.setAnchorProof('ff'.repeat(32) + '.0', { proven: true, height: 42, merkleRoot: 'aa'.repeat(32) })
  const after = await store.get('ff'.repeat(32) + '.0')
  assert.equal(after.anchor.proven, true)
  assert.equal(after.anchor.height, 42)
  assert.equal(after.anchor.merkleRoot, 'aa'.repeat(32))
  store.close()
})

test('sqlite: a token survives a close and reopen of the same file', async () => {
  const file = join(await mkdtemp(join(tmpdir(), 'bolt-store-')), 'tokens.db')
  const a = nodeSqliteStore(file)
  await a.put(sample())
  a.close()

  const b = nodeSqliteStore(file)
  const rec = await b.get(sample().id)
  assert.ok(rec, 'the row survived the reopen')
  assert.equal(rec.type, 'FutureBOLT')
  assert.equal(rec.anchor.merkleRoot, 'ef'.repeat(32))
  b.close()
})

test('list filters by issuer and type', async () => {
  const store = nodeSqliteStore()
  await store.put(sample({ id: '11'.repeat(32) + '.0', type: 'AuthBOLT' }))
  await store.put(sample({ id: '22'.repeat(32) + '.0', type: 'MinSimpleBOLT' }))
  assert.equal((await store.list()).length, 2)
  assert.equal((await store.list({ type: 'AuthBOLT' })).length, 1)
  assert.equal((await store.list({ issuer: ISS })).length, 2)
  assert.equal((await store.list({ issuer: 'nope' })).length, 0)
  store.close()
})
