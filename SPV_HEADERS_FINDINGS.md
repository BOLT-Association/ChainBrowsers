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
- The bsv-wallet issue is drafted but not posted, and its main claim (proofs stored without a root check) is fixed upstream since the audit; see the re-audit below before posting anything.
- Maxthon, a third BSV browser, has unverified API compatibility.

## Re-audit of bsv-browser, 2026-10-04 (fork master `baf14a0`: toolbox 0.11.0, wallet-toolbox-mobile 2.14.3)

The notes above describe toolbox 0.4.0. Checked against the installed 0.11.0 code; line numbers are not quoted because they moved.

| Finding | 0.11.0 state | After the `spv-hardening` patch (spv mode only) |
|---|---|---|
| Header store accepts any chain at the proof-of-work limit: no retarget or most-work | **Partly fixed.** Headers above the mainnet limit are now refused (the forged easy-`bits` chain the earlier audit missed is closed on mainnet). Still no retarget, no median-time-past, no most-work: `syncHeaders` rewinds at most 144 headers, otherwise resets. | Per-chain rules (`chainRules.ts`), most-work reorg selection with a depth limit, every stored header re-validated on open. Only **regtest** rules exist; spv refuses chains without rules. |
| CWI `getHeaderForHeight` / `getHeight` come from the remote | **Still true** (`Services` reads `options.chaintracks`, the remote client). | Answered from the verified chain; a height it lacks is an error. |
| Proofs stored without checking the root | **Mostly fixed upstream.** `EntityProvenTx.fromReq` now authenticates the root with the chain tracker before storing, so the drafted bsv-wallet issue is **stale**: do not post it as written. | Same call, but the tracker is the strict one, so the root is checked against the wallet's own chain; a proof for a block the chain does not hold is retried, not stored. |
| `isValidRootForHeight` asks the network on a miss | **Partly fixed.** A mismatch inside the validated window body is refused; a miss or a mismatch in the last 6 headers still asks the network and caches the answer (`putExtraRoot`), after a proof-of-work check on that header. | Never asks the network, never reads the unverified `-extra` cache. |
| (new) Toolbox cannot read a non-mainnet chain | `ChaintracksServiceClient`, `hashToHeader` and the Arcade proof provider check proof-of-work against the mainnet limit, so a regtest chain is refused at the first header. | `RawChaintracksClient` (transport only), `hashToHeader` from the verified chain, and an Arcade proof service (`arcadeMerklePath.ts`) for regtest. |

Public mode is unchanged, so the first, second and fourth rows still describe a default build. Work, tests and run guide: `docs/bsv-browser-spv.md`.
