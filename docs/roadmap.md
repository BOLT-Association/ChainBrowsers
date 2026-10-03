# Roadmap

## Phase 0 – Chain stack (done, lives in spv-testnet)
- [x] Teranode regtest + merkle-service + Arcade, one-command boot, tx round trip and forced reorg tested (see spv-testnet README for known issues)
- [ ] Fix or work around: second reorg on one chain stalls `generate`; 401s from Teranode's asset server to Arcade

## Phase 1 – Browser SPV checks (the browsers own SPV; we verify it)
- [ ] Browser syncs headers from Arcade chaintracks (`:8083`) / Teranode asset server, accepting regtest PoW rules
- [ ] Browser verifies BUMPs against its own header chain
- [ ] Browser handles reorgs: switches to the heaviest chain and re-checks affected transactions and token state

## Phase 2 – BOLT
- [ ] Wire b017 into `packages/bolt`; validate lineage using SPV proofs rather than a full node
- [ ] Token state store keyed by outpoint, re-evaluated on reorg
- [ ] Mint / transfer / split / merge / melt flows via Arcade

## Phase 3 – Browsers
- [ ] Hodos Browser (desktop, Rust wallet) first, then BSV Browser (mobile, Expo); see `browsers/README.md`
- [ ] Injected provider API for pages to request BOLT operations

## Phase 4 – Scenarios
- [ ] Deep and shallow reorgs that orphan a BOLT transfer; token returns to prior owner/state
- [ ] Double-spend across a reorg
- [ ] Offline browser catches up through N blocks

## Open questions
- Header source: Teranode asset server directly, or a Chaintracks-like service?
- Proof delivery: Arcade callbacks/SSE, merkle-service, or overlay?
