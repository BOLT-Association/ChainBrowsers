---
name: browser-header-audit
description: "Key conclusions from the 2026-09-29 audit of Hodos and bsv-browser header/SPV handling, and open decisions"
metadata:
  node_type: memory
  type: project
  originSessionId: eb765c3f-5e09-4b94-ad5a-8432db3fb548
  modified: 2026-10-03T13:14:51.723Z
---

Neither browser's `window.CWI` header calls can be trusted. bsv-browser: checks linkage and PoW only (no retarget/most-work), stores merkle proofs without checking they compute to the header root. Hodos: no real header chain (lazy WhatsOnChain cache), no PoW/linkage checks, `internalize_action` root check is TODO. Details in SPV_HEADERS_FINDINGS.md (line refs unverified).

Open: the user's own Hodos working copy (PeerZone/Hodos-Browser) has an uncommitted WS4 roadmap edit; bsv-wallet issue drafted, not posted; Maxthon unverified.

**Why:** Phase 1 of the roadmap is verifying that each browser's own SPV is sound against spv-testnet. See [[chainbrowsers-status]].
**How to apply:** treat header/proof handling as the first thing to test, and don't post the issue or commit to Hodos without asking.

**Hodos WS4 status (2026-10-03):** done in Hodos branch `arcade-provider` for regtest: `header_chain.rs` (PoW, fixed difficulty, linkage, pinned genesis, most-work, reorg), `header_sync.rs`, V26 `header_chain` table, proof checks against it (`verify_tsc_proof_against_block`, `internalize_action` BUMPs, `TaskRecheckProofs` after reorgs), live reorg verified. Remaining: mainnet checkpoint + DAA + median-time-past, bsv-browser equivalents. The Hodos `getHeight`/`getHeaderForHeight` CWI bugs are fixed in spv mode only.

**Re-audit 2026-10-04 (bsv-browser fork master, toolbox 0.11.0):** several findings are fixed upstream (proof root authentication, window-body mismatch refusal, mainnet PoW-limit cap); still open in public mode: no retarget/most-work, CWI header calls from the remote, network fallback on a miss/tail. The drafted bsv-wallet issue is STALE, do not post as written. spv-mode fixes for all of it are in [[bsv-browser-spv]].
