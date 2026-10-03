// Does proof delivery still work when push does not? Runs the unmined-subject scenario under
// different SSE conditions and times how long after the block is mined the output becomes
// spendable (= the proof was verified, stored and the output promoted).
//
//   1. push working        expect: a few seconds, and Arcade's MINED event passed through the proxy
//   2. SSE refused (503)   expect: polling delivers it (about a minute)
//   3. SSE up but silent   expect: polling delivers it (keepalives only, no events)
//   4. SSE killed, then restored after the block: reconnect/replay and/or polling delivers it
//
// Setup (see ../../docs/hodos-spv.md):
//   node proxy.mjs &                         (fault-injecting proxy: API :8090, control :8091)
//   wallet started with HODOS_ARCADE_URL=http://localhost:8090 HODOS_ARCADE_SSE_URL=http://localhost:8090
//   docker stop cb-block-generator           (the scenarios mine by hand)
import { unminedFlow, ok, sleep } from './lib.mjs'

const CONTROL = 'http://localhost:8091'
const ctl = async path => (await fetch(CONTROL + path)).json()
const proxy = {
  setMode: m => ctl(`/mode?sse=${m}`),
  kill: () => ctl('/kill'),
  stats: () => ctl('/stats')
}

const FUND = 3_000_000
const SPEND = 2_500_000
const results = []

async function scenario (name, { mode, maxMs, expectMinedEvent, beforeMine }) {
  await proxy.setMode(mode)
  await proxy.kill() // make the wallet reconnect under the new mode
  await sleep(6000) // give its client time to reconnect (backoff is short after a clean drop)
  const before = (await proxy.stats()).minedEvents
  console.log(`\n== ${name} (sse=${mode})`)
  const r = await unminedFlow({ fund: FUND, spend: SPEND, pollMs: 2000, beforeMine: beforeMine ? () => beforeMine(proxy) : undefined })
  const minedEvents = (await proxy.stats()).minedEvents - before
  const secs = (r.elapsedMs / 1000).toFixed(1)
  console.log(`   spendable ${secs}s after the block was mined; MINED events through the proxy: ${minedEvents}`)
  ok(r.elapsedMs <= maxMs, `${name}: spendable within ${maxMs / 1000}s (took ${secs}s)`)
  if (expectMinedEvent === true) ok(minedEvents > 0, `${name}: Arcade's MINED event reached the wallet's stream`)
  if (expectMinedEvent === false) ok(minedEvents === 0, `${name}: no MINED event was delivered (so polling did the work)`)
  results.push({ name, secs: Number(secs), minedEvents })
}

const only = process.argv.slice(2).map(Number)
const run = (n, name, opts) => (only.length === 0 || only.includes(n)) ? scenario(name, opts) : null

await run(1, 'push works', { mode: 'pass', maxMs: 25_000, expectMinedEvent: true })
await run(2, 'SSE refused', { mode: 'refuse', maxMs: 150_000, expectMinedEvent: false })
await run(3, 'SSE up but silent', { mode: 'silent', maxMs: 150_000, expectMinedEvent: false })
await run(4, 'SSE dropped over the block, restored after', {
  mode: 'pass', maxMs: 150_000,
  beforeMine: async p => { await p.setMode('refuse'); await p.kill(); setTimeout(() => p.setMode('pass'), 4000) }
})

console.log('\nSummary:'); for (const r of results) console.log(`  ${r.name.padEnd(48)} ${String(r.secs).padStart(6)}s  (MINED events seen: ${r.minedEvents})`)
console.log('PASS push fallback')
process.exit(0)
