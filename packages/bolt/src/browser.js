// The in-page BOLT shim for Hodos (the "fat page-side" model).
//
// Hodos has no trusted JS runtime, so the BOLT handler runs in the page's main world and drives the
// wallet over Hodos's existing IPC rail: window.__hodos_walletCall(method, '/'+method, args), the same
// bridge window.CWI rides. Everything that leaves the page goes through the wallet:
//   - keys, signatures, funding: the BRC-100 methods (getPublicKey, createSignature, createAction),
//     each behind the wallet's own consent, so the key never leaves the wallet;
//   - headers: getHeaderForHeight (the wallet's verified chain);
//   - the network: POST /boltBroadcast (a page cannot reach the chain service itself);
//   - the tokens held: POST /boltTokens (the wallet's table, so tokens belong to the wallet and not
//     to this site's storage).
//
// Consent note: because the handler lives in the page, the BOLT-semantic prompt in page.js's dispatcher
// cannot be trusted here. The user's consent is at BRC-100 granularity (the wallet's "sign/pay" modals
// on createAction/createSignature), not "transfer token X to Y". A trusted, BOLT-semantic prompt needs
// the handler to run on the browser's trusted side (bsv-browser's RN app does; Hodos cannot today).
//
// Bundled with b017 + @bsv/sdk into one IIFE (scripts/bundle-shim.mjs) and injected by the browser.
import { BoltHandler } from './handler.js'
import { brc100Core } from './core.js'
import { IDENTITY_MINT, PAGE_METHODS, isIdentity } from './page.js'
import { walletBroadcaster, walletStore } from './wallet-rail.js'

/**
 * Install `window.BOLT` into `target` (the page global). Returns the handler.
 * @param walletCall     `(method, endpoint, args) => Promise<any>`: the wallet bridge. It resolves with
 *                       the wallet's JSON reply; defaults to window.__hodos_walletCall
 * @param trustedIssuers issuer public keys (hex) the page's verify/receive will accept
 * @param target         where to define BOLT (default globalThis / window)
 */
export function installBolt ({ walletCall, trustedIssuers = [], target = globalThis } = {}) {
  const bridge = walletCall ?? ((method, endpoint, args) => target.__hodos_walletCall(method, endpoint, args))
  // Hodos reports a wallet error as a reply with an `error` body.
  const call = async (endpoint, args = {}) => {
    const name = endpoint.slice(1)
    const reply = await bridge(name, endpoint, args)
    if (reply && reply.error) throw new Error(`${name}: ${typeof reply.error === 'string' ? reply.error : JSON.stringify(reply.error)}`)
    return reply
  }
  const wallet = Object.fromEntries(
    ['getPublicKey', 'createSignature', 'getHeaderForHeight', 'createAction'].map((m) => [m, (args) => call('/' + m, args)])
  )
  const core = brc100Core({ wallet, broadcast: walletBroadcaster(call), store: walletStore(call) })
  const handler = new BoltHandler({ core, trustedIssuers })

  const api = {}
  for (const method of Object.keys(PAGE_METHODS)) {
    api[method] = (...args) => handler[method](...args)
  }
  // Identities are the wallet's: a page cannot mint one, and asks for a presentation through the
  // wallet's own prompt (POST /bolt/request, which Hodos answers natively: the person chooses or
  // creates the identity, and the page receives only the presentation).
  api.mint = async (opts) => {
    if (isIdentity(opts)) throw new Error(IDENTITY_MINT)
    return handler.mint(opts)
  }
  api.requestPresentation = (req) => call('/bolt/request', req)
  Object.defineProperty(target, 'BOLT', { value: Object.freeze(api), writable: false, configurable: false, enumerable: true })
  return handler
}
