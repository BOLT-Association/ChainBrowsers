// Fault-injecting proxy between the wallet and Arcade, for testing the push fallback.
//
// The wallet is pointed at this proxy for BOTH its API and SSE URLs:
//   HODOS_ARCADE_URL=http://localhost:8090   HODOS_ARCADE_SSE_URL=http://localhost:8090
// Everything except /events is passed straight to Arcade's API (:8080). /events is handled
// according to the current SSE mode:
//   pass     proxy to Arcade's SSE service (:8082)
//   refuse   answer 503 (the wallet cannot connect)
//   silent   answer 200 and send only `: keepalive` comments: the stream looks healthy but no
//            event ever arrives (a dropped/undelivered callback)
// Control (port 8091):  GET /mode?sse=pass|refuse|silent   POST /kill   GET /stats
import http from 'node:http'

export function startProxy ({ port = 8090, controlPort = 8091, api = 'http://localhost:8080', sse = 'http://localhost:8082' } = {}) {
  const state = { mode: 'pass', open: new Set(), stats: { sseConnections: 0, refused: 0, silent: 0, events: 0, minedEvents: 0 } }

  const proxyTo = (target, req, res, onData) => {
    const u = new URL(req.url, target)
    const up = http.request(u, { method: req.method, headers: { ...req.headers, host: u.host } }, ur => {
      res.writeHead(ur.statusCode, ur.headers)
      if (onData) ur.on('data', onData)
      ur.pipe(res)
    })
    up.on('error', () => { try { res.writeHead(502); res.end() } catch {} })
    res.on('close', () => up.destroy())
    req.pipe(up)
    return up
  }

  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/events')) return proxyTo(api, req, res)
    state.stats.sseConnections++
    if (state.mode === 'refuse') { state.stats.refused++; res.writeHead(503); return res.end('sse refused by proxy') }
    state.open.add(res)
    res.on('close', () => state.open.delete(res))
    if (state.mode === 'silent') {
      state.stats.silent++
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(': keepalive\n\n')
      const t = setInterval(() => res.write(': keepalive\n\n'), 15000)
      res.on('close', () => clearInterval(t))
      return
    }
    proxyTo(sse, req, res, chunk => {
      const text = chunk.toString('utf8')
      state.stats.events += (text.match(/event: status/g) || []).length
      state.stats.minedEvents += (text.match(/"txStatus":"MINED"/g) || []).length
    })
  })

  const control = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/mode') state.mode = u.searchParams.get('sse') ?? state.mode
    if (u.pathname === '/kill') { for (const r of state.open) r.destroy(); state.open.clear() }
    if (u.pathname === '/stats') { /* falls through to the common reply below */ }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ mode: state.mode, openStreams: state.open.size, ...state.stats }))
  })

  return new Promise(resolve => server.listen(port, () => control.listen(controlPort, () => resolve({
    state,
    setMode: m => { state.mode = m },
    kill: () => { for (const r of state.open) r.destroy(); state.open.clear() },
    close: () => { for (const r of state.open) r.destroy(); server.close(); control.close() }
  }))))
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('proxy.mjs')) {
  await startProxy()
  console.log('proxy on :8090 (control :8091), SSE mode = pass')
}
