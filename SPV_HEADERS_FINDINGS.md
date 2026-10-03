# SPV Block-Header Findings: Hodos & bsv-browser

Source: audit of 2026-09-29, written up from saved notes on 2026-10-03. File and line references have not been re-checked against current code.

## bsv-browser (mobile, React Native)

The wallet core is `@bsv/expo-wallet-toolbox` 0.4.0 (repo bsv-blockchain/bsv-wallet, `packages/expo-wallet-toolbox`), built on `@bsv/wallet-toolbox-mobile` 2.4.3. Headers come from Arcade Chaintracks (`arcade-v2-*.bsvblockchain.tech/chaintracks/v1`), set per network by env vars.

**Missing or weak**
- **Difficulty and most-work checks:** the local header window (`core/headers/headerStore.ts`) is anchored at a built-in checkpoint (mainnet height 907324). It checks linkage and proof-of-work, but not difficulty retarget rules or most-work.
- **Unverified header calls:** CWI `getHeaderForHeight` always comes from the remote service, with no check.
- **Merkle proof bug:** fetched proofs are stored without checking that the proof computes to the header's root. An issue is drafted but not posted.
- **Root validation:** `OfflineFirstChaintracks.isValidRootForHeight` accepts a matching local root, but on a miss or mismatch it asks the network.

## Hodos (desktop, CEF)

**Missing or weak**
- **No header chain:** `block_headers` is only a lazy cache of WhatsOnChain and JungleBus answers.
- **No header checks:** headers get no proof-of-work or linkage checks.
- **Proof verification:** `verify_tsc_proof_against_block` checks against WhatsOnChain live, and most callers store the proof anyway when WhatsOnChain is down.
- **Missing root check:** the `internalize_action` root check is still a TODO.
- **Bad CWI results:** `get_height` can return 0 as a success, and `get_header_for_height` can return `""`.

## Decisions (2026-09-29)

- Neither browser's `window.CWI` header calls should be trusted.
- PeerLoop gets its own fully checked header sync (plan item `t38`, from question `t05`). p2pd does it with Go's standard library only, and the browser re-checks. bsv-browser's `core/headers/` is the reference design.
- Hodos gets the same, added as **WS4** in `Hodos-Browser/development-docs/Wallet-Hardening/WALLET_HARDENING_ROADMAP.md`.

## Still open

- The WS4 edit is uncommitted on Hodos `main`, alongside an unrelated uncommitted `frontend/package-lock.json` change. Whether to commit it on a branch is undecided.
- The bsv-wallet issue is drafted but not posted. Post it with `gh issue create -R bsv-blockchain/bsv-wallet --body-file ...`.
- Maxthon, a third BSV browser, has unverified API compatibility.
