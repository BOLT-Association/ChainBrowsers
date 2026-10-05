// The in-page BOLT shim for Hodos (the "fat page-side" model).
//
// Hodos has no trusted JS runtime, so the BOLT handler runs in the page's main world and drives the
// wallet over Hodos's existing IPC rail: window.__hodos_walletCall(method, '/'+method, args), the same
// bridge window.CWI rides. The wallet still gates every funding/signing call with its own BRC-100
// consent, so the key never leaves the wallet; what the page gains is the BOLT operations (token logic,
// b017) without the wallet knowing anything about tokens.
//
// Consent note: because the handler lives in the page, the BOLT-semantic prompt in page.js's dispatcher
// cannot be trusted here. The user's consent is at BRC-100 granularity (the wallet's "sign/pay" modals
// on createAction/createSignature), not "transfer token X to Y". A trusted, BOLT-semantic prompt needs
// the handler to run on the browser's trusted side (bsv-browser's RN app can; Hodos cannot today).
//
// Bundled with b017 + @bsv/sdk into one IIFE (scripts/bundle-shim.mjs) and injected by the browser.
import { BoltHandler } from './handler.js'
import { brc100Core } from './core.js'
import { PAGE_METHODS } from './page.js'

/** A BRC-100 wallet adapter over Hodos's injected bridge. `walletCall(method, endpoint, args)` returns
 *  the parsed JSON the wallet replied with (Hodos reports errors as an `error` body). */
function bridgeWallet (walletCall) {
  const call = (method) => async (args = {}) => {
    const res = await walletCall(method, '/' + method, args)
    if (res && res.error) throw new Error(`${method}: ${res.error}`)
    return res
  }
  return {
    getPublicKey: call('getPublicKey'),
    createSignature: call('createSignature'),
    getHeaderForHeight: call('getHeaderForHeight'),
    createAction: call('createAction')
  }
}

/**
 * Install `window.BOLT` into `target` (the page global). Returns the handler.
 * @param walletCall     `(method, endpoint, args) => Promise<any>`; defaults to window.__hodos_walletCall
 * @param arcadeUrl      Arcade's API base the handler broadcasts to, fetched from the page's origin —
 *                       so on a real site it is subject to the site's CSP and Arcade's CORS and is
 *                       likely blocked. Broadcast should be proxied through the wallet rail (not done).
 * @param trustedIssuers issuer public keys (hex) the page's verify/receive will accept
 * @param target         where to define BOLT (default globalThis / window)
 */
export function installBolt ({ walletCall, arcadeUrl, trustedIssuers = [], target = globalThis } = {}) {
  const bridge = walletCall ?? ((method, endpoint, args) => target.__hodos_walletCall(method, endpoint, args))
  const handler = new BoltHandler({ core: brc100Core({ wallet: bridgeWallet(bridge), arcadeUrl, fetch: target.fetch?.bind(target) }), trustedIssuers })

  const api = {}
  for (const method of Object.keys(PAGE_METHODS)) {
    api[method] = (...args) => handler[method](...args)
  }
  Object.defineProperty(target, 'BOLT', { value: Object.freeze(api), writable: false, configurable: false, enumerable: true })
  return handler
}
