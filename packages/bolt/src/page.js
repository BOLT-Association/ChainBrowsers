// The page side of the interface: what a site calls, and how a browser serves it.
//
//   page:     window.BOLT = pageClient(send)        send(request) -> Promise<response>, any transport
//   browser:  const serve = dispatcher({ handler, approve })
//             response = await serve(origin, request)
//
// The transport is the browser's own (postMessage in a WebView, IPC in CEF), the same as it uses for
// window.CWI. A request is `{ method, args }`; a response is `{ result }` or `{ error }`.

/** What a page may call, and whether the user is asked first. */
export const PAGE_METHODS = {
  getKey: { asks: false },
  list: { asks: false },
  verify: { asks: false },
  receive: { asks: true },
  // An identity (AuthBOLT) is shown only through the wallet's own prompt, which asks the person and
  // chooses the token; the page gets the presentation and nothing else. A page cannot present.
  requestPresentation: { asks: false },
  // A holder-key signature for an app the identity is registered with (sign-in, keep-alive, a
  // write): the wallet signs silently only under the person's keep-signed-in grant and only what
  // the app's published tiers call silent; otherwise it asks in its own prompt.
  sign: { asks: false },
  // The name the app accepted for an identity linked to it (after a successful sign-in): the wallet
  // keeps it to show in its prompts instead of a key. Never asks; the name is the app's text.
  label: { asks: false },
  transfer: { asks: true },
  pay: { asks: true },
  melt: { asks: true },
  mint: { asks: true }
}

/** AuthBOLT identities are the wallet's: minted and presented only behind its own prompt. */
export const IDENTITY_MINT = 'BOLT: AuthBOLT identities are minted by the wallet, not by a page'
export const isIdentity = (opts) => (opts?.type ?? 'AuthBOLT') === 'AuthBOLT'

/** The object a page sees. */
export function pageClient (send) {
  const call = (method) => async (...args) => {
    const response = await send({ method, args })
    if (response?.error) throw new Error(response.error)
    return response?.result
  }
  return Object.freeze(Object.fromEntries(Object.keys(PAGE_METHODS).map((m) => [m, call(m)])))
}

// What the user is shown. Every fragment that comes from the page is clamped to printable ASCII and a
// short length, so a page cannot write its own sentence into the wallet's prompt.
const show = (x, n) => String(x ?? '').replace(/[^\x21-\x7e]/g, '').slice(0, n)

const describe = {
  receive: () => 'keep a BOLT token sent to this wallet',
  transfer: ([id, to]) => `transfer token ${show(id, 8)} to ${show(to, 12)}; the token leaves this wallet`,
  pay: ([issuer, amount, to]) => `pay ${show(amount, 40)} of token ${show(issuer, 12)} to ${show(to, 12)}`,
  melt: ([id]) => `melt (destroy) token ${show(id, 8)}; it cannot be recovered`,
  mint: ([opts]) => `mint a new ${show(opts?.type ?? 'AuthBOLT', 24)} token${opts?.amount != null ? ` of ${show(opts.amount, 40)}` : ''} with this wallet as its issuer`
}

/**
 * Serve page requests from a BoltHandler.
 * @param approve  `({ origin, method, summary }) => Promise<boolean>`: the browser's prompt. Unlike a
 *                 BRC-100 signature request, the summary says what is being signed.
 */
export function dispatcher ({ handler, approve }) {
  return async (origin, request) => {
    try {
      const { method, args = [] } = request ?? {}
      const rule = Object.hasOwn(PAGE_METHODS, method) ? PAGE_METHODS[method] : undefined
      if (!rule) return { error: `BOLT: unsupported method ${String(method)}` }
      if (!Array.isArray(args)) return { error: 'BOLT: args must be an array' }
      if (method === 'mint' && isIdentity(args[0])) return { error: IDENTITY_MINT }
      if (typeof handler[method] !== 'function') return { error: 'BOLT: this browser cannot present an identity yet' }
      if (rule.asks && !(await approve({ origin, method, summary: describe[method](args) }))) {
        return { error: 'BOLT: the user declined' }
      }
      const result = await handler[method](...args)
      // `verify` and `receive` carry Transaction objects for in-process callers; a page gets plain data.
      if (result && typeof result === 'object' && 'txs' in result) delete result.txs
      return { result }
    } catch (e) {
      return { error: `BOLT: ${e?.message ?? e}` }
    }
  }
}
