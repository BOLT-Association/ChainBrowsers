# Roadmap

Everything verified so far is on the local regtest stack; spv mode is meant for testnet and mainnet
through an external Arcade. Updated 2026-10-10.

## Next (in this order)

Done 2026-10-10/11 (`docs/authbolt-onchain-holder-keys.md`, "Follow-ups"): the Hodos spv outage
defect (spv mode retries an unreachable Arcade, never fails the tx); the identity last used for an
app comes first; a wallet ahead of the app catches it up (deterministic rotation challenges + the
`resume` sign kind); move packages carry proofs instead of mined history (wallet `/boltProof`, fundd
from Arcade).

1. **AuthBOLT: registration invites** (the user's decision: remove `-open-signup`, invite only), and
   per-identity limits on what fundd pays for.
2. **AuthBOLT: a restored wallet re-imports its identity token.** A wallet restored from its seed can
   derive every identity and holder key but has no token record. Restore by account name (the app
   hands back the last package to a signature by the issuer key), plus a fast path from an identity
   index (site, key, username) kept in the wallet's backup.
3. **Testnet / mainnet header rules** in both browsers (checkpoint, difficulty adjustment,
   median-time-past). This is what makes spv mode usable off regtest, and the reason for the work.
4. **Housekeeping:** refresh the open PR descriptions (ChainBrowsers #3, Hodos #1, bsv-browser #1,
   b017 #3 and #2); recreate the bsv-browser emulator wallet on the reset chain; verify
   `window-bolt` on a device; macOS build of the Hodos C++ (relay rounds W-07a, W-07b).

## Phase 0 – Chain stack (done, lives in spv-testnet)
- [x] Teranode regtest + merkle-service + Arcade, one-command boot, tx round trip and forced reorg tested (see spv-testnet README for known issues)
- [x] Repeated forced reorgs on one chain work (`rpc_timeout` and `generateTipWaitTimeout` raised in `settings.conf`); the Teranode asset-server 401s to Arcade are harmless (Arcade's health probe)
- [x] Genesis and Chronicle active from block 1 (a patched build of the pinned Teranode; upstream regtest activates them at 100 and 200, and BOLT covenants need Chronicle's script rules)
- Arcade API: `POST /tx` / `GET /tx/{txid}` have no `/v1` prefix (only `/v1/policy` is aliased), new submissions return `202`, and there is no API key

## Phase 1 – Browser SPV checks (the browsers own SPV; we verify it)
- [x] Both browsers sync headers from Arcade chaintracks (`:8083`) under regtest PoW rules, triggered by its tip stream
- [x] Both verify BUMPs against their own header chain (Hodos takes the leaf by txid: a BUMP may flag several client txids)
- [x] Both handle reorgs: most-work chain, stored proofs re-checked
- [ ] Token state re-evaluated on reorg (Phase 4)

## Phase 2 – BOLT (`packages/bolt`, `docs/bolt-browser.md`)
- [x] b017 wired into `packages/bolt`; lineage checked with SPV proofs
- [x] Token store keyed by outpoint (Hodos `bolt_tokens`, bsv-browser expo-sqlite)
- [x] Mint / transfer / split / merge / melt via Arcade, live on Hodos
- [x] `window.BOLT` in Hodos (verified in a real page); in bsv-browser on branch `window-bolt` (not device-verified)
- [ ] BOLT tokens in each wallet's backup
- [ ] Scope `/boltTokens` by site or issuer (any approved site can list and retire all non-identity tokens)
- [ ] Load the 425 KB page shim on first use rather than into every https page

## Phase 3 – Browsers
- [x] Hodos `HODOS_CHAIN_MODE=spv`: Arcade only, wallet-verified header chain, BEEF proof checks, reorg re-check, push (Arcade SSE) and tip stream, zero-conf (`docs/hodos-spv.md`)
- [x] bsv-browser `EXPO_PUBLIC_CHAIN_MODE=spv` (fork branch `spv-hardening`, a `patch-package` patch): the same, plus the app running in the Android emulator (`docs/bsv-browser-spv.md`)
- [x] Cross-wallet e2e: both browsers side by side in spv mode, paying each other (`tests/cross-wallet`, `docs/cross-wallet-e2e.md`)
- [ ] Testnet / mainnet header rules in both (Next 3)
- [ ] Hodos: double-spend suspects stay suspected in spv mode (no per-input spent check)
- [ ] bsv-browser: the toolbox's SSE client does not reconnect by itself (decided 2026-10-04: not worth fixing yet)
- [ ] A wallet-to-wallet channel that works in spv mode (Hodos refuses PeerPay in spv mode)

## Phase 3b – AuthBOLT sign-in (PeerLoop + Hodos; `docs/authbolt-registration.md`, `docs/authbolt-onchain-holder-keys.md`)
- [x] Users issue their own identities; registration moves the token on chain from its mint to holder key 1, paid by the app (fundd, exact SIGHASH_SINGLE | ANYONECANPAY coins through the page)
- [x] Sign-in, keep-alive and writes are holder-key signatures; prompted changes shown as text
- [x] Rotations on chain when the app asks; reissue for a dead token; a wallet out of step signs with the holder the app names
- [x] Account names shown in the wallet's prompts (`BOLT.label`, after a successful sign-in)
- [x] Live in Hodos (`tests/authbolt/peerloop.live.mjs`, negative controls `NC_NO_VERIFIER`, `NC_NO_FUND`)
- [ ] Next 1-5 above

## Phase 4 – Scenarios
- [ ] Deep and shallow reorgs that orphan a BOLT transfer; token returns to prior owner/state
- [ ] Double-spend across a reorg
- [ ] Offline browser catches up through N blocks

## Answered questions
- Header source: Arcade's embedded chaintracks (`/chaintracks/v2`, bulk headers and a tip stream); no separate service.
- Proof delivery: Arcade's SSE stream (the MINED frame carries the merkle path), with polling as the fallback.
