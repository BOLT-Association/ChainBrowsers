// The in-page shim: run the real bundled IIFE (dist/bolt-shim.js) inside a fake page (node:vm) with a
// mock of Hodos's wallet_call bridge, and prove it installs window.BOLT and drives the wallet over the
// bridge. The token logic itself is covered by handler/fungible/store tests; this covers the shim wiring.
//
// Run `node scripts/bundle-shim.mjs` first (the test skips with a clear message if the bundle is absent).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { Hash, Utils } from '@bsv/sdk'
import { PAGE_METHODS } from '../src/index.js'

const bundlePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bolt-shim.js')

/** A fake page: run the bundle, then install BOLT with a mock bridge. Returns the page global + a log of
 *  the (method, endpoint) pairs the bridge saw. `replies` maps a method to the JSON the wallet returns. */
function page (replies = {}) {
  const seen = []
  const walletCall = async (method, endpoint, args) => {
    seen.push({ method, endpoint, args })
    const reply = replies[method]
    return typeof reply === 'function' ? reply(args) : reply
  }
  const sandbox = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(readFileSync(bundlePath, 'utf8'), sandbox)
  sandbox.BoltShim.installBolt({ walletCall, trustedIssuers: [], target: sandbox })
  return { g: sandbox, seen }
}

test('the bundle installs a frozen window.BOLT with exactly the page methods', { skip: !existsSync(bundlePath) && 'run scripts/bundle-shim.mjs first' }, () => {
  const { g } = page()
  assert.ok(g.BOLT, 'window.BOLT is defined')
  assert.deepEqual(Object.keys(g.BOLT).sort(), Object.keys(PAGE_METHODS).sort())
  assert.throws(() => { g.BOLT = 1 }, 'BOLT is non-writable')
  assert.ok(Object.isFrozen(g.BOLT))
})

test('window.BOLT.getKey() drives the wallet over the bridge', { skip: !existsSync(bundlePath) && 'run scripts/bundle-shim.mjs first' }, async () => {
  const pub = '02' + '11'.repeat(32)
  const { g, seen } = page({ getPublicKey: () => ({ publicKey: pub }) })

  const key = await g.BOLT.getKey()
  assert.equal(key.publicKey, pub)
  assert.equal(key.pubKeyHash, Utils.toHex(Hash.hash160(Utils.toArray(pub, 'hex'))))
  // it reached the wallet over the bridge, at the BRC-100 endpoint window.CWI would use
  assert.deepEqual(seen.map((c) => [c.method, c.endpoint]), [['getPublicKey', '/getPublicKey']])
})

test('window.BOLT.list() returns holdings without touching the wallet', { skip: !existsSync(bundlePath) && 'run scripts/bundle-shim.mjs first' }, async () => {
  const { g, seen } = page()
  assert.equal((await g.BOLT.list()).length, 0) // from the vm realm, so compare by length not deepEqual
  assert.equal(seen.length, 0)
})

test('a wallet error surfaces as a thrown error', { skip: !existsSync(bundlePath) && 'run scripts/bundle-shim.mjs first' }, async () => {
  const { g } = page({ getPublicKey: () => ({ error: 'user declined' }) })
  await assert.rejects(g.BOLT.getKey(), /getPublicKey: user declined/)
})
