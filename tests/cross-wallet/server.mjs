// Relay between the test and one page per browser.
//
// Each browser opens the same page (page/index.html?role=<name>). The page long-polls this
// server for commands, runs each against the browser's own wallet (BRC-100), and posts the
// result back. The test calls relay.call(role, method, args) and gets the wallet's answer,
// so everything the wallets exchange passes through here and is shown on both pages.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const PAGE = fileURLToPath(new URL('./page/index.html', import.meta.url))

export function startRelay ({ port = Number(process.env.RELAY_PORT ?? 8095) } = {}) {
  const roles = new Map() // role -> { queue: [], waiting: res | null, seenAt: number }
  const pending = new Map() // id -> { resolve, reject }
  let nextId = 1

  const role = name => {
    if (!roles.has(name)) roles.set(name, { queue: [], waiting: null, seenAt: 0 })
    return roles.get(name)
  }
  const flush = r => {
    if (r.waiting && r.queue.length) {
      const res = r.waiting
      r.waiting = null
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(r.queue.shift()))
    }
  }
  const body = req => new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))).on('error', reject)
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://relay')
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(await readFile(PAGE))
      } else if (req.method === 'GET' && url.pathname === '/poll') {
        const r = role(url.searchParams.get('role') ?? '')
        // One page per role: the newest page instance wins, an older copy (a stale tab) is told to stop.
        const inst = url.searchParams.get('inst') ?? ''
        if (url.searchParams.has('hello')) r.inst = inst
        if (inst !== r.inst) { res.writeHead(410).end(); return }
        r.seenAt = Date.now()
        // The page's first request: answer at once so it can show it is connected.
        if (url.searchParams.has('hello')) { res.writeHead(204).end(); return }
        if (r.waiting) r.waiting.writeHead(204).end()
        r.waiting = res
        flush(r)
        // An empty answer before the browser's own timeout; the page polls again.
        setTimeout(() => { if (r.waiting === res) { r.waiting = null; res.writeHead(204).end() } }, 20000)
      } else if (req.method === 'POST' && url.pathname === '/result') {
        const m = JSON.parse(await body(req))
        const p = pending.get(m.id)
        if (p) {
          pending.delete(m.id)
          if (m.ok) p.resolve(m.value)
          else p.reject(Object.assign(new Error(m.error?.message ?? 'wallet error'), { code: m.error?.code, body: m.error?.body }))
        }
        res.writeHead(204).end()
      } else {
        res.writeHead(404).end()
      }
    } catch (e) {
      res.writeHead(500).end(String(e))
    }
  })

  const send = (name, command) => { const r = role(name); r.queue.push(command); flush(r) }

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve({
      port,
      /** True once the page for `name` has polled within the last 30 s. */
      connected: name => Date.now() - role(name).seenAt < 30000,
      /** Run a wallet method in the browser showing the page for `name`. `quiet`: the page does not list the call. */
      call: (name, method, args = {}, { timeout = 120000, quiet = false } = {}) => new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name}.${method} timed out`)) }, timeout)
        pending.set(id, {
          resolve: v => { clearTimeout(timer); resolve(v) },
          reject: e => { clearTimeout(timer); reject(e) }
        })
        send(name, { id, kind: 'call', method, args, quiet })
      }),
      /** Show a line on the page for `name` (kind: step | ok | fail). */
      note: (name, text, kind = 'step') => send(name, { kind: 'note', text, level: kind }),
      close: () => new Promise(r => { for (const x of roles.values()) x.waiting?.writeHead(204).end(); server.close(r); server.closeAllConnections?.() })
    }))
  })
}

// `node server.mjs` runs the relay alone, for bringing a browser up by hand.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const relay = await startRelay()
  console.log(`relay on http://localhost:${relay.port}/?role=hodos and http://10.0.2.2:${relay.port}/?role=bsv`)
}
