---
name: working-rules-chainbrowsers
description: How to work safely and in line with the user's preferences in ChainBrowsers/Hodos/spv-testnet (running wallets, git/push, BSV semantics, design discussions)
metadata:
  type: feedback
---

**Running a wallet:** never run `hodos-wallet` without `HODOS_DEV=1` + `HODOS_DATA_DIR=<scratch>` (the Windows data dir ignores `APPDATA`; an un-redirected run opens and migrates the real `HodosBrowserDev` DB). To test on a real DB, copy `wallet.db` + `-wal` + `-shm`, run on the copy, delete it, and confirm the real files' size/mtime are unchanged. Stop only my own process by exe path, never by image name. Build with cargo from bash, not PowerShell; stop the wallet before rebuilding.
**Why:** the user's installed/dev Hodos shares names and data dirs; a dev wallet on the real DB, or a copy that polls MessageBox, can touch real data or acknowledge real messages. spv mode now makes no MessageBox calls.

**Git:** commit and push only when the user asks, every time (spv-testnet's `CLAUDE.md` says so explicitly; approval does not carry over). Commit trailers: `Co-Authored-By` + `Claude-Session` lines from the session reminder. Ask before DB schema changes in Hodos (its rules); surgical changes, update layer `CLAUDE.md`, negative control for every test.

**BSV semantics:** the user thinks in BSV-native terms (outputs spendable once seen on the network, Arcade callbacks/SSE, BEEF/SPV). Don't default to Bitcoin-Core-style conservatism. When I propose a conservative default, say whether it is existing Hodos policy or my own addition, and give the simplest version first (they chose "simple, no cap" for zero-conf).

**Design discussions:** the user asks pointed "why/isn't it better to…" questions and wants a clear recommendation, honest about what is design preference vs constraint (e.g. I said "polling stays the only writer"; it was a preference). Answer what was asked, then act; don't re-ask settled decisions. Don't claim a feature exists that doesn't (callbacks did not exist when asked); say what was and wasn't tested.
