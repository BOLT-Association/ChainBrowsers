# Roadmap

## Phase 0 – Chain stack (done, lives in spv-testnet)
- [x] Teranode regtest + merkle-service + Arcade, one-command boot, tx round trip and forced reorg tested (see spv-testnet README for known issues)
- [x] Repeated forced reorgs on one chain work (`rpc_timeout` and `generateTipWaitTimeout` raised in `settings.conf`); the Teranode asset-server 401s to Arcade are harmless (Arcade's health probe)
- Arcade differs from public ARC: `POST /tx` / `GET /tx/{txid}` have no `/v1` prefix (only `/v1/policy` is aliased), new submissions return `202`, and there is no API key

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
  - [ ] Hodos: Arcade provider replaces ARC GorillaPool/TAAL for broadcast, tx status and proofs (`HODOS_ARCADE_URL`)
  - [ ] Hodos: chaintracks header provider and a local UTXO source (raw-tx, outspend, UTXO and header chains still use mainnet providers)
- [ ] Injected provider API for pages to request BOLT operations

## Phase 4 – Scenarios
- [ ] Deep and shallow reorgs that orphan a BOLT transfer; token returns to prior owner/state
- [ ] Double-spend across a reorg
- [ ] Offline browser catches up through N blocks

## Open questions
- Header source: Teranode asset server directly, or a Chaintracks-like service?
- Proof delivery: Arcade callbacks/SSE, merkle-service, or overlay?
