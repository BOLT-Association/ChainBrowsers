#!/usr/bin/env node
// bolt-verify: the AuthBOLT check sidecar for an app server (src/verify-server.js).
//
//   BOLT_VERIFY_SECRET   shared with the app server, 16+ characters (required)
//   ARCADE_URL           Arcade's API, for the anchor's network status (default http://localhost:8080)
//   HEADERS_URL          the app server's verified header chain (required), e.g. http://127.0.0.1:8099
//   BOLT_VERIFY_PORT     default 8097; it listens on 127.0.0.1 only
import { BoltHandler, arcadeBroadcaster, memoryStore } from '../src/index.js'
import { createVerifyServer, headersTracker } from '../src/verify-server.js'

const secret = process.env.BOLT_VERIFY_SECRET ?? ''
const arcadeUrl = process.env.ARCADE_URL ?? 'http://localhost:8080'
const headersUrl = process.env.HEADERS_URL
const port = Number(process.env.BOLT_VERIFY_PORT ?? 8097)
if (!headersUrl) {
  console.error('bolt-verify: set HEADERS_URL to the app server\'s header chain (it is the only judge of roots)')
  process.exit(2)
}

const isValidRootForHeight = headersTracker({ url: headersUrl, secret })
const core = {
  store: memoryStore(),
  isValidRootForHeight,
  broadcast: arcadeBroadcaster({ arcadeUrl, isValidRootForHeight }),
  publicKey: async () => { throw new Error('bolt-verify holds no keys') },
  signDigest: async () => { throw new Error('bolt-verify holds no keys') },
  fund: async () => { throw new Error('bolt-verify spends nothing') }
}
const server = createVerifyServer({ handler: new BoltHandler({ core }), secret })
server.listen(port, '127.0.0.1', () => {
  console.log(`bolt-verify on http://127.0.0.1:${port} (arcade ${arcadeUrl}, headers ${headersUrl})`)
})
