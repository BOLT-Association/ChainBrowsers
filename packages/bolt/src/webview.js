// window.BOLT for a WebView host (bsv-browser): the thin page side and the trusted host side.
//
//   page:  the host injects webViewProviderScript() at document start. It defines window.BOLT, whose
//          methods post { type: 'BOLT', id, method, args } through window.ReactNativeWebView.postMessage
//          and wait for the host's reply.
//   host:  hostService({ wallet, ... }) is the handler behind a dispatcher. The host calls it with
//          the page's origin (which the host determines; the page is never asked) and sends back
//          boltReply(id, response) as a `message` event in the page.
//
// The handler, the keys, the token store and the prompt all stay in the host. The page holds nothing.
import { BoltHandler } from './handler.js'
import { brc100Core } from './core.js'
import { PAGE_METHODS, dispatcher } from './page.js'

export const BOLT_MESSAGE = 'BOLT'

/** The reply to a page request: `response` is the dispatcher's `{ result }` or `{ error }`. */
export const boltReply = (id, response) => ({ type: BOLT_MESSAGE, id, isReply: true, ...response })

/**
 * The script that defines window.BOLT in a page. Main frame only. A call is refused after
 * `timeoutMs` without a reply (long enough for the user to read a prompt and for the network).
 */
export function webViewProviderScript ({ timeoutMs = 180000 } = {}) {
  return `(function () {
  if (window.BOLT || window.top !== window) return;
  var bridge = window.ReactNativeWebView;
  if (!bridge || typeof bridge.postMessage !== 'function') return;
  var n = 0;
  function newId () {
    try {
      var b = new Uint8Array(16); crypto.getRandomValues(b);
      var s = ''; for (var i = 0; i < b.length; i++) s += (b[i] + 256).toString(16).slice(1);
      return s;
    } catch (_) { return 'bolt_' + (++n) + '_' + Date.now() + '_' + Math.random().toString(36).slice(2); }
  }
  function invoke (method, args) {
    return new Promise(function (resolve, reject) {
      var id = newId();
      var timer = setTimeout(function () { done(); reject(new Error('BOLT: the wallet did not answer')); }, ${Number(timeoutMs)});
      function onMessage (e) {
        if (e.source && e.source !== window) return; // the host's replies carry no source
        var data; try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (_) { return; }
        if (!data || data.type !== ${JSON.stringify(BOLT_MESSAGE)} || data.id !== id || data.isReply !== true) return;
        done();
        if (typeof data.error === 'string') reject(new Error(data.error)); else resolve(data.result);
      }
      function done () { clearTimeout(timer); window.removeEventListener('message', onMessage); }
      window.addEventListener('message', onMessage);
      try { bridge.postMessage(JSON.stringify({ type: ${JSON.stringify(BOLT_MESSAGE)}, id: id, method: method, args: args })); }
      catch (_) { done(); reject(new Error('BOLT: could not reach the wallet')); }
    });
  }
  var api = {};
  ${JSON.stringify(Object.keys(PAGE_METHODS))}.forEach(function (m) {
    api[m] = function () { return invoke(m, Array.prototype.slice.call(arguments)); };
  });
  Object.defineProperty(window, 'BOLT', { value: Object.freeze(api), writable: false, configurable: false, enumerable: true });
})();`
}

/**
 * The trusted side: a handler on the host's wallet, behind the dispatcher.
 * @param wallet    the host's wallet for the app's own calls: `getPublicKey`, `createSignature`,
 *                  `getHeaderForHeight`, `createAction` (one argument each)
 * @param arcadeUrl Arcade's API, or `broadcast` to reach the network another way
 * @param store     the host's token store (e.g. `sqlStore` over the app's SQLite)
 * @param approve   `({ origin, method, summary }) => Promise<boolean>`: the host's prompt. `summary`
 *                  says what is being asked ("transfer token … to …")
 * @returns `serve(origin, { method, args }) => Promise<{ result } | { error }>`; requests are served
 *          one at a time, in the order they arrive
 */
export function hostService ({ wallet, arcadeUrl, broadcast, fetch, store, approve, trustedIssuers = [] }) {
  const handler = new BoltHandler({ core: brc100Core({ wallet, arcadeUrl, broadcast, fetch, store }), trustedIssuers })
  const serve = dispatcher({ handler, approve })
  // One request at a time: two pages (or one page twice) must not pick the same token to spend.
  let last = Promise.resolve()
  return (origin, request) => {
    const answer = last.then(() => serve(origin, request))
    last = answer.catch(() => {})
    return answer
  }
}
