// Driving the Hodos browser (dev build) for the cross-wallet test.
//
// The browser and its spv wallet are started by hand or by start-hodos.ps1 (scratch data
// directories; see docs/cross-wallet-e2e.md). This module only talks to them:
//   - the wallet's HTTP API, with no X-Requesting-Domain header (the wallet's own calls), to
//     approve the test page's domain the way the connect prompt would;
//   - the dev build's DevTools port, to open tabs and to click a prompt if one still appears.
import { writeFileSync } from 'node:fs'

const WALLET = process.env.WALLET_URL ?? 'http://127.0.0.1:31401'
const CDP = process.env.HODOS_CDP ?? 'http://127.0.0.1:9322'
const FRONTEND = process.env.HODOS_FRONTEND ?? 'http://127.0.0.1:5137'

export async function wallet (path, body) {
  const r = await fetch(WALLET + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

/**
 * Approve `domain` (host:port, as Hodos names a page's origin) with caps high enough that the
 * test's payments are not prompted: what a user does once in the connect and limits dialogs.
 */
export async function approveDomain (domain) {
  const r = await wallet('/domain/permissions', {
    domain,
    trustLevel: 'approved',
    perTxLimitCents: 100000,
    perSessionLimitCents: 1000000,
    rateLimitPerMin: 600,
    maxTxPerSession: 0,
    identityKeyDisclosureAllowed: true,
    bundledScopeGrant: true
  })
  if (r.status !== 200) throw new Error(`could not approve ${domain}: ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}

/** DevTools targets. Every Hodos overlay is a "page", so targets are always chosen by URL. */
export const targets = async () => (await fetch(CDP + '/json/list')).json()

async function withTarget (match, fn) {
  const list = (await targets()).filter(t => (typeof match === 'function' ? match(t.url) : t.url.includes(match)))
  if (list.length !== 1) throw new Error(`expected one DevTools target for ${match}, found ${list.length}: ${list.map(t => t.url).join(', ')}`)
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('DevTools socket failed')) })
  let id = 0
  const pending = new Map()
  ws.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } }
  const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  try { return await fn(send) } finally { ws.close() }
}

/** Evaluate `expression` in the one target whose URL matches; returns its value. */
export const evaluate = (match, expression) => withTarget(match, async send => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
})

/** Open `url` in a new Hodos tab, as the browser's own tab bar does (a real navigation). */
export const openTab = url =>
  evaluate(u => u === FRONTEND || u === FRONTEND + '/', `window.cefMessage.send('tab_create', ${JSON.stringify(url)}); true`)

/**
 * Approve Hodos's permission modals for the length of a test, as a person at the browser would.
 * The modal is its own DevTools target (/brc100-auth); when it is showing a request, its
 * Allow / Approve / Connect button is clicked with element.click(),
 * which runs the modal's real handler (the pattern of Hodos's own ipcconnect.py harness).
 * Hodos still asks for a payment when it has no BSV price, whatever the domain's limits are.
 * Returns a function that stops the watcher and gives the list of what was approved.
 */
export function autoApprove ({ onApprove = () => {}, every = 700 } = {}) {
  const approved = []
  let busy = false
  const timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      // The overlay is kept alive and its URL stays `type=idle` even while it shows a request, so
      // what it is asking is read from its content: an enabled, visible approve button.
      const r = await evaluate('/brc100-auth', `(function () {
        const b = Array.from(document.querySelectorAll('button')).find(x => !x.disabled && x.offsetParent !== null && /^\\s*(allow|approve|connect)/i.test(x.textContent || ''))
        if (!b || b.dataset.xwClicked) return null
        const what = document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160)
        b.dataset.xwClicked = '1'
        b.click()
        return { button: b.textContent.trim(), what }
      })()`)
      if (r) { approved.push(r); onApprove(r) }
    } catch { /* the modal closed between the listing and the click; the next tick looks again */ }
    busy = false
  }, every)
  return () => { clearInterval(timer); return approved }
}

/** Save a PNG of the one target whose URL matches (the tab's own rendering, whatever is in front of it). */
export const capture = (match, file) => withTarget(match, async send => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(file, Buffer.from(r.data, 'base64'))
})

/** True when a tab showing `urlPart` exists. */
export const hasTab = async urlPart => (await targets()).some(t => t.url.includes(urlPart))

// `node hodos.mjs approve <domain>` / `node hodos.mjs open <url>` / `node hodos.mjs targets`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'approve') console.log(await approveDomain(arg))
  else if (cmd === 'open') console.log(await openTab(arg))
  else if (cmd === 'targets') for (const t of await targets()) console.log(t.type, t.url)
  else console.log('usage: node hodos.mjs approve <domain> | open <url> | targets')
}
