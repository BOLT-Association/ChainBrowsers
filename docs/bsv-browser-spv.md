# Running BSV Browser (bsv-browser) in spv mode against the local chain

`EXPO_PUBLIC_CHAIN_MODE=spv` makes the wallet use **only** Arcade (broadcast, status, proofs) and Arcade's chaintracks (headers, verified by the wallet's own header chain). It never contacts public indexers and never talks to Teranode. Outputs and parent transactions reach the wallet inside BEEFs (`internalizeAction`), not by address lookup.

The work is on branch `spv-hardening` of [BOLT-Association/bsv-browser](https://github.com/BOLT-Association/bsv-browser) (clone it into `browsers/bsv-browser/`, which is gitignored here). What it does, the configuration, the patch layout and the known gaps are in that branch's `docs/SPV_MODE.md`; this page is the run guide and the audit status.

**Current state, stated plainly:** built and verified against the local `spv-testnet` regtest stack with a **headless** wallet (the real toolbox `Wallet` and `StorageExpoSQLite` on an in-memory SQLite database). The Expo app has **not** been run in spv mode on a device or emulator. The header rules are **regtest-only**; spv on mainnet, testnet or teratest with default rules is refused at wallet build, so it cannot be pointed at a real network yet.

## Why a patch, and why the tests live in the fork

The wallet core (`@bsv/expo-wallet-toolbox`, which ships TypeScript source, on `@bsv/wallet-toolbox-mobile`, a single bundle) is a dependency, not app code. The header store, chain tracker and proof storage are in it, so the hardening is a `patch-package` patch (`patches/@bsv+expo-wallet-toolbox+0.11.0+001+spv-hardening.patch`). For the same reason the tests run under the app's own jest setup (`jest-expo`), which can load that source, rather than as a plain Node script like `tests/hodos-spv`.

## 1. Chain stack

```powershell
cd <spv-testnet>\stack
.\stack.ps1 up        # Arcade :8080, chaintracks :8083 (v1 and v2), Teranode RPC :29292 (harness only)
```

The toolbox reads `/chaintracks/v1` (`getPresentHeight`, `getHeaders`); Arcade serves both v1 and v2.

## 2. Tests (no device)

```bash
cd browsers/bsv-browser
npm ci                                              # postinstall applies the patches
npx jest __tests__/spv                              # unit tests
node scripts/spv-negative-controls.mjs              # each rule disabled in turn; every test must go red
SPV_LIVE=1 npx jest __tests__/spv/live --runInBand  # live, against the stack above
```

The live tests need Docker (they stop `cb-block-generator` for the reorg test and start it again) and run serially. Do not run them while something else is using the stack's chain.

Verified live: header sync from genesis equals the node's roots; a chaintracks that forges a merkle root is rejected; a real reorg is followed to the heavier branch; a BEEF for a block the wallet's own chain has not reached is refused, then accepted after the wallet's sync; a BEEF with a tampered BUMP is rejected; a spend through Arcade is broadcast and its proof is not stored before the wallet's chain holds the block, and is stored after (root equal to the node's); a lying Arcade serving a tampered BUMP gets nothing stored; the wallet contacted only the configured Arcade and chaintracks.

## 3. Pointing the app at it

From an emulator or device use the host's LAN IP, not `localhost`.

```
EXPO_PUBLIC_CHAIN_MODE=spv
EXPO_PUBLIC_DEFAULT_CHAIN=teratest
EXPO_PUBLIC_TERATEST_ARC_URL=http://<LAN-IP>:8080
EXPO_PUBLIC_TERATEST_CHAINTRACKS_URL=http://<LAN-IP>:8083/chaintracks/v1
EXPO_PUBLIC_SPV_RULES=regtest
EXPO_PUBLIC_SPV_ANCHOR_HEIGHT=0
EXPO_PUBLIC_SPV_ANCHOR_HASH=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206
```

Startup (wallet build) refuses spv without both URLs, with a URL that is a public indexer, or on a chain with no difficulty rules; an unrecognised `EXPO_PUBLIC_CHAIN_MODE` means spv, never public. Untested on a device: treat the first run as a test of the app wiring, with a throwaway wallet.

## Audit status (SPV_HEADERS_FINDINGS.md, re-checked 2026-10-04)

The 2026-09-29 audit read toolbox 0.4.0 / mobile 2.4.3. The fork is on 0.11.0 / 2.14.3, and some of it is fixed upstream. See the table in `SPV_HEADERS_FINDINGS.md`.
