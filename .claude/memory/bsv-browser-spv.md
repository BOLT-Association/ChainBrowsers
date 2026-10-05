---
name: bsv-browser-spv
description: "State of the bsv-browser spv-mode hardening (branches, PRs, what is verified, open items, traps) as of 2026-10-04"
metadata:
  node_type: memory
  type: project
  originSessionId: eb765c3f-5e09-4b94-ad5a-8432db3fb548
  modified: 2026-10-04T20:25:31.374Z
---

**Intent (user, 2026-10-04):** target bsv-browser, fix the failings in SPV_HEADERS_FINDINGS.md, test it on a par with Hodos, then add Arcade auth, SSE push, https-only URLs and zero-conf on top of the same branch. Decisions: land in the fork `BOLT-Association/bsv-browser` and patch the toolbox (patch-package, not upstream first); regtest first; headless jest harness for live tests; ask before posting any issue.

**Where / PRs (all pushed on the user's explicit "yes", 2026-10-04):** fork clone `browsers/bsv-browser`, branch `spv-hardening` (commits ae95e95, 4c001ee) = BOLT-Association/bsv-browser PR #1 into the fork's `master`. ChainBrowsers branch `docs/bsv-browser-spv` (3545b70) = ChainBrowsers PR #2 (PR #1 was merged). Hodos PR #1 is still the user's to merge. User merges; don't merge. The user's own clone `PeerZone\bsv-browser` is older (toolbox 0.4.0), read-only.

**Built** (toolbox patch `patches/@bsv+expo-wallet-toolbox+0.11.0+001+spv-hardening.patch`, app files `utils/spvEnv.ts`, `app/_layout.tsx`, `docs/SPV_MODE.md`): per-chain header rules (regtest only), most-work reorg sync, strict chain tracker, Arcade-only services + fetch guard, raw chaintracks client, Arcade proof service, `hashToHeader` from the verified chain, https-only origins, Arcade API key (Bearer) in every Arcade client, SSE via `EXPO_PUBLIC_SPV_SSE_URL`, zero-conf gate (accept an unmined payment only once Arcade has seen it; otherwise refuse, unlike Hodos which parks it). spv refuses main/test/ttn (no difficulty rules). Tests: ~170 unit (`__tests__/spv`), 40 negative controls (`scripts/spv-negative-controls.mjs`, all red), 19 live (run by name, `--runInBand`). Full jest: only `__tests__/vault/guard.test.ts` fails (pre-existing).

**Open:** run the app itself on a device/emulator (another session is bringing up the Android emulator in this clone); mainnet/testnet rules (DAA, MTP, checkpoints); toolbox SSE client does not reconnect by itself (`fetchSSEEvents()` only); public mode unchanged by design; the drafted bsv-wallet issue is stale (proof storage is fixed upstream), do not post as written; possible toolbox bug: empty-string Arcade API key rejected by its SSE client (worked around in spv).

**Traps:** the fork is on toolbox 0.11.0 (the audit read 0.4.0). `npx patch-package <pkg>` fails here, so the patch is generated from a diff against the pristine tarball and proven with `npm ci` in a scratch dir. Windows Python writes CRLF and turns `\n` in non-raw strings into real newlines (use `newline=''`, or the Write tool). Live test wallets need a unique callback token (Arcade replays past events per token). A child of an unmined parent mines a block later; the toolbox rebroadcasts received unmined txs after ~7 s. `getblock` may omit `tx` for 1-tx blocks (use `merkleroot`). Details in ChainBrowsers `CLAUDE.md` section "bsv-browser: what to know before touching it".

**Shared clone and stack:** the Claude session `cross-wallet-e2e-spv-testing` works in the same bsv-browser clone and on the same spv-testnet stack (files `__tests__/spv/live/crosswallet.live.test.ts`, `hodosClient.ts`, `tests/cross-wallet/` are its, never stage them; it runs a Hodos wallet on :31401 and Metro on :8081). Coordinate by SendMessage before live runs or touching `node_modules/@bsv`; both sessions start/stop `cb-block-generator`.

**Why:** see [[browser-header-audit]], [[chainbrowsers-status]], [[working-rules-chainbrowsers]].
**How to apply:** ask before commit/push/PR or posting anything; run live tests serially by name after messaging the other session.

**Decision (2026-10-04, asked by the user): SSE reconnect is not worth fixing yet.** The toolbox's SSE client does not reconnect by itself (only `monitor.fetchSSEEvents()`, which the app calls on open/refresh), but push is a latency gain behind working polling and proofs are verified identically either way; it matters mainly for fast double-spend/status events on zero-conf. The polling interval for new headers was not measured. If the emulator run shows stalled pushes after backgrounding, add a foreground timer calling `fetchSSEEvents()` about every 30 s (about 20 lines in our own code, unit test + a live test that kills the stream); do not build a custom SSE client.

**Update 2026-10-04 (late):** the app has now run in spv mode in an Android emulator and exchanged payments with the Hodos browser ([[cross-wallet-e2e-status]]). That run found the toolbox monitor checking headers against mainnet proof of work (TaskNewHeader failed every poll on regtest, so unmined receipts were never proven in the app); fixed in `core/spv/monitorHeaders.ts`, pushed to `spv-hardening` (920536e, plus c1917e8 for the headless cross-wallet test). "Run the app on a device/emulator" in Open above is done for the emulator only. The other session that shared the clone had ended by then.
