# Roadmap

## Phase 0 – Chain stack (done, lives in spv-testnet)
- [x] Teranode regtest + merkle-service + Arcade, one-command boot, tx round trip and forced reorg tested (see spv-testnet README for known issues)
- [x] Repeated forced reorgs on one chain work (`rpc_timeout` and `generateTipWaitTimeout` raised in `settings.conf`); the Teranode asset-server 401s to Arcade are harmless (Arcade's health probe)
- Arcade API: `POST /tx` / `GET /tx/{txid}` have no `/v1` prefix (only `/v1/policy` is aliased), new submissions return `202`, and there is no API key

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
  - [x] Hodos: `HODOS_CHAIN_MODE=spv` — Arcade for broadcast/status/proofs, chaintracks for headers, wallet-verified header chain (PoW, difficulty, most-work, reorg), BEEF proof checks, reorg proof re-check, no public-indexer calls
  - [x] Hodos: fund a wallet in spv mode by BEEF and spend it (`tests/hodos-spv`, run guide `docs/hodos-spv.md`); verified on a real wallet process with a throwaway data dir
  - [x] Hodos: promote an internalized output whose BEEF subject had no BUMP when its proof arrives later (spv mode; `tests/hodos-spv/fund-unmined.mjs`)
  - [ ] Hodos: wake the proof task from Arcade's SSE stream instead of waiting for the 60 s poll (optional latency work)
  - [ ] Hodos: spv mode has no per-input spent check, so double-spend suspects stay suspected; decide how BEEF/competingTxs can resolve them
  - [ ] Hodos: mainnet header rules (checkpoint, difficulty adjustment, median-time-past)
  - [x] bsv-browser: `EXPO_PUBLIC_CHAIN_MODE=spv` (branch `spv-hardening` of the fork, a `patch-package` patch on `@bsv/expo-wallet-toolbox`) — Arcade only, wallet-verified header chain (regtest rules, most-work reorg), strict chain tracker, proofs stored only after the wallet's own chain verifies them, public indexers refused; unit tests with negative controls and live headless-wallet tests (`docs/bsv-browser-spv.md`)
  - [ ] bsv-browser: run the app (not just the headless wallet) in spv mode on a device or emulator
  - [ ] bsv-browser: mainnet / testnet header rules (checkpoint, difficulty adjustment, median-time-past), Arcade authentication, SSE push, zero-conf
  - [ ] bsv-browser: public mode still trusts the remote for page-facing header calls (opt-in switch by design); decide whether to harden it or send the changes upstream
- [ ] Injected provider API for pages to request BOLT operations

## Phase 4 – Scenarios
- [ ] Deep and shallow reorgs that orphan a BOLT transfer; token returns to prior owner/state
- [ ] Double-spend across a reorg
- [ ] Offline browser catches up through N blocks

## Open questions
- Header source: Teranode asset server directly, or a Chaintracks-like service?
- Proof delivery: Arcade callbacks/SSE, merkle-service, or overlay?
