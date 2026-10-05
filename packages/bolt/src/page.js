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
  present: { asks: true },
  transfer: { asks: true },
  mint: { asks: true }
}

/** The object a page sees. */
export function pageClient (send) {
  const call = (method) => async (...args) => {
    const response = await send({ method, args })
    if (response?.error) throw new Error(response.error)
    return response?.result
  }
  return Object.freeze(Object.fromEntries(Object.keys(PAGE_METHODS).map((m) => [m, call(m)])))
}

const describe = {
  receive: () => 'keep a BOLT token sent to this wallet',
  present: ([id, opts]) => `show token ${String(id).slice(0, 8)} to this site${opts?.data ? ` with the data ${String(opts.data).slice(0, 32)}` : ''}`,
  transfer: ([id, to]) => `transfer token ${String(id).slice(0, 8)} to ${String(to).slice(0, 12)}; the token leaves this wallet`,
  mint: ([opts]) => `mint a new ${opts?.type ?? 'AuthBOLT'} token with this wallet as its issuer`
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
