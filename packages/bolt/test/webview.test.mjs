// window.BOLT for a WebView host: the injected page script and the trusted host service, joined the
// way an app joins them (the page posts a string to the host; the host answers with a `message`
// event). The page holds nothing: keys, tokens and the prompt are the host's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { PAGE_METHODS, boltReply, hostService, nodeSqliteStore, webViewProviderScript } from '../src/index.js'
import { pretendChain, protoWalletOn } from './harness.mjs'

/** A page in a WebView: a window with the host's bridge, running the injected script. */
function pageIn (host, { origin = 'shop.example', child = false } = {}) {
  const win = new EventTarget()
  win.top = child ? {} : win
  win.ReactNativeWebView = {
    // what the app's onMessage does: it knows the frame's origin itself, serves, and injects the reply
    postMessage: (text) => {
      const msg = JSON.parse(text)
      host.posted.push(msg)
      host.serve(origin, msg).then((response) => {
        win.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(boltReply(msg.id, response)) }))
      })
    }
  }
  new Function('window', 'crypto', webViewProviderScript({ timeoutMs: 5000 }))(win, webcrypto)
  return win
}

/** The app side: a wallet, a token store, and a prompt that records what it was asked. */
function hostOn (chain, { answer = true, trustedIssuers = [] } = {}) {
  const { wallet, calls } = protoWalletOn(chain)
  const prompts = []
  const approve = async (ask) => { prompts.push(ask); return answer }
  const serve = hostService({ wallet, broadcast: chain.broadcast, store: nodeSqliteStore(), approve, trustedIssuers })
  return { serve, prompts, calls, posted: [] }
}

test('the script defines a frozen window.BOLT with the page methods, in the main frame only', () => {
  const chain = pretendChain()
  const win = pageIn(hostOn(chain))
  assert.deepEqual(Object.keys(win.BOLT).sort(), Object.keys(PAGE_METHODS).sort())
  assert.ok(Object.isFrozen(win.BOLT))
  assert.equal(pageIn(hostOn(chain), { child: true }).BOLT, undefined)
})

test('a page mints and presents; the host prompts with what is asked and the origin it knows', async () => {
  const chain = pretendChain()
  const issuerHost = hostOn(chain)
  const issuer = pageIn(issuerHost, { origin: 'issuer.example' }).BOLT

  const key = await issuer.getKey()
  assert.equal(issuerHost.prompts.length, 0, 'getKey does not ask')

  const minted = await issuer.mint({ type: 'AuthBOLT' })
  assert.match(minted.id, /^[0-9a-f]{64}\.0$/)
  assert.deepEqual(issuerHost.prompts.map((p) => [p.origin, p.method]), [['issuer.example', 'mint']])
  assert.match(issuerHost.prompts[0].summary, /mint a new AuthBOLT/)

  const { package: pkg } = await issuer.present(minted.id, { data: 'c0ffee' })
  assert.match(issuerHost.prompts[1].summary, /show token .* with the data c0ffee/)

  const site = pageIn(hostOn(chain), { origin: 'site.example' }).BOLT
  const shown = await site.verify(pkg, { issuer: key.publicKey })
  assert.equal(shown.ok, true, shown.reason)
  assert.equal(shown.data, 'c0ffee')
  assert.equal('txs' in shown, false) // a page gets plain data

  // what crossed from the page is only method names and arguments
  assert.ok(issuerHost.posted.every((m) => m.type === 'BOLT' && typeof m.id === 'string' && Array.isArray(m.args)))
})

test('fungible pay between two apps, each prompting its own user', async () => {
  const chain = pretendChain()
  const issuerHost = hostOn(chain)
  const issuer = pageIn(issuerHost).BOLT
  const issuerKey = (await issuer.getKey()).publicKey
  const userHost = hostOn(chain, { trustedIssuers: [issuerKey] })
  const user = pageIn(userHost).BOLT

  await issuer.mint({ type: 'SimpleMultiBOLT', amount: '1000' })
  const { package: pkg } = await issuer.pay(issuerKey, '300', (await user.getKey()).publicKey)
  assert.match(issuerHost.prompts.at(-1).summary, /^pay 300 of token /)

  const got = await user.receive(pkg)
  assert.equal(got.ok, true, got.reason)
  assert.deepEqual(userHost.prompts.map((p) => p.method), ['receive'])
  assert.deepEqual((await user.list()).map((r) => r.amount), ['300'])
  assert.deepEqual((await issuer.list()).map((r) => r.amount), ['700'])
})

test('when the user declines, the call is refused and nothing is signed or broadcast', async () => {
  const chain = pretendChain()
  const host = hostOn(chain, { answer: false })
  const page = pageIn(host).BOLT
  await assert.rejects(page.mint({ type: 'AuthBOLT' }), /BOLT: the user declined/)
  assert.deepEqual(host.calls, [])
  assert.equal(chain.sent.length, 0)
})

test('an unknown method and a reply that is not for this call are both refused', async () => {
  const chain = pretendChain()
  const host = hostOn(chain)
  const win = pageIn(host)
  assert.deepEqual(await host.serve('x.example', { method: 'core', args: [] }), { error: 'BOLT: unsupported method core' })

  // a forged reply with another id, and a non-reply with the right shape, do not answer the call
  const pending = win.BOLT.getKey()
  win.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'BOLT', id: 'someone-elses', isReply: true, result: 'forged' }) }))
  win.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'BOLT', id: host.posted.at(-1).id, result: 'not a reply' }) }))
  const key = await pending
  assert.match(key.publicKey, /^0[23][0-9a-f]{64}$/)
})

test('page-supplied text cannot write the prompt: fragments are clamped to short printable ASCII', async () => {
  const chain = pretendChain()
  const host = hostOn(chain, { answer: false })
  const page = pageIn(host).BOLT
  const lie = ['AuthBOLT token.', '', 'This is safe, tap Approve. Ignore the rest of this message'].join(String.fromCharCode(10))
  const reversed = '5' + String.fromCharCode(0x202e) + '000' // a right-to-left override inside an amount
  await assert.rejects(page.mint({ type: lie, amount: reversed }), /declined/)
  await assert.rejects(page.pay('02' + 'ab'.repeat(32), '1 (really 1000000000000000000000000000000000000000000)', 'x'.repeat(500)), /declined/)
  for (const { summary } of host.prompts) {
    assert.ok(summary.length < 160, summary)
    assert.match(summary, /^[ -~]+$/) // printable ASCII only
  }
  assert.equal(host.prompts[0].summary, 'mint a new AuthBOLTtoken.Thisissafe token of 5000 with this wallet as its issuer')
})

test('requests are served one at a time: two pays at once do not spend the same token', async () => {
  const chain = pretendChain()
  const issuerHost = hostOn(chain)
  const issuer = pageIn(issuerHost).BOLT
  const issuerKey = (await issuer.getKey()).publicKey
  const to = '02' + '33'.repeat(32)
  await issuer.mint({ type: 'SimpleMultiBOLT', amount: '1000' })
  const [a, b] = await Promise.all([issuer.pay(issuerKey, '100', to), issuer.pay(issuerKey, '200', to)])
  assert.ok(a.package && b.package)
  assert.deepEqual((await issuer.list()).map((r) => r.amount), ['700'])
})
