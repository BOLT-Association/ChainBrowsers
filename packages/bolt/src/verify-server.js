// bolt-verify: an AuthBOLT check for an app server that cannot run b017 itself (PeerLoop's p2pd is
// standard-library Go). One route:
//
//   POST /verify  { package: [commit, settle], appPubKey, data }  ->  verifyIdentity's answer
//
// A refusal is an ordinary 200 answer `{ ok: false, reason }`; 4xx means the request itself was
// wrong. Every request must carry `Authorization: Bearer <secret>`. Bind it to loopback.
//
// Chain trust stays with the app: the handler's chain tracker is `headersTracker`, which asks the
// app server whether a merkle root is in ITS verified header chain. The only thing this service asks
// the network (Arcade) is whether the anchor a presentation stands on has been seen.
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { verifyIdentity } from './identity.js'

const MAX_BODY = 1024 * 1024
const isHexString = (s) => typeof s === 'string' && s.length > 0 && s.length % 2 === 0 && /^[0-9a-f]+$/i.test(s)

function sameSecret (given, secret) {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

function reply (res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * @param handler  a BoltHandler whose core judges anchors (broadcast) and roots (isValidRootForHeight)
 * @param secret   the shared secret (16+ characters) the app server sends as a Bearer token
 */
export function createVerifyServer ({ handler, secret }) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('bolt-verify needs a secret of 16 or more characters')
  return http.createServer((req, res) => {
    const path = new URL(req.url, 'http://local').pathname
    if (path === '/healthz') return reply(res, 200, { ok: true })
    if (path !== '/verify') return reply(res, 404, { error: 'not found' })
    if (req.method !== 'POST') return reply(res, 405, { error: 'POST only' })
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ') || !sameSecret(auth.slice(7), secret)) return reply(res, 401, { error: 'unauthorized' })

    const chunks = []
    let size = 0
    let tooBig = false
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { tooBig = true; return }
      chunks.push(c)
    })
    req.on('end', async () => {
      if (tooBig) return reply(res, 413, { error: `body over ${MAX_BODY} bytes` })
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return reply(res, 400, { error: 'invalid JSON' }) }
      const { package: pkg, appPubKey, data } = body ?? {}
      if (!Array.isArray(pkg) || pkg.length < 2 || pkg.length > 4 || !pkg.every(isHexString) || !isHexString(appPubKey) || !isHexString(data)) {
        return reply(res, 400, { error: 'want { package: [hex, hex], appPubKey: hex, data: hex }' })
      }
      try {
        const r = await verifyIdentity({ handler, package: pkg, appPubKey, data })
        reply(res, 200, r)
      } catch (e) {
        reply(res, 200, { ok: false, reason: `verification failed: ${e?.message ?? e}` })
      }
    })
  })
}

/**
 * A chain tracker that asks the app server, which keeps its own verified header chain:
 *   GET <url>/headers/root?height=H&root=R  ->  { active: boolean, undecided: boolean }
 * Only `active: true` is a yes; an unreachable server, an error or an undecided root is a no.
 */
export function headersTracker ({ url, secret, fetch = globalThis.fetch, timeoutMs = 5000 }) {
  return async (root, height) => {
    try {
      const q = new URLSearchParams({ height: String(height), root })
      const res = await fetch(`${url}/headers/root?${q}`, {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return false
      return (await res.json()).active === true
    } catch {
      return false
    }
  }
}
