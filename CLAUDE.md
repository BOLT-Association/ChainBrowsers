# Notes for Claude

Test environment for BOLT / SPV work in Bitcoin-enabled browsers against a local regtest chain. Start with `README.md`, `docs/roadmap.md` and `docs/hodos-spv.md`. This file holds only what is not obvious from those or the code.

## Working agreements

- Commit when asked; **never push without asking each time**. Approval to push once does not carry over.
- End commits with the `Co-Authored-By` line from the session's attribution reminder.
- `browsers/<name>/` are separate clones (gitignored here). Hodos work lives on branch `arcade-provider` of `BOLT-Association/Hodos-Browser`; the org's `main` = `staging`, and its `0.4.0` branch is old (the Hodos `CLAUDE.md` still tells you to rebase onto it; ignore that for this remote).
- The chain stack is the separate repo `BOLT-Association/spv-testnet`. This repo depends on it, it does not contain it.

## Safety: running a wallet

- ⛔ **Never run `hodos-wallet` without redirecting its data dir.** On Windows the data dir comes from the known-folder API, **not** the `APPDATA` variable, so overriding `APPDATA` does nothing and the process would open the real `HodosBrowserDev` DB and migrate it. Use `HODOS_DEV=1` + `HODOS_DATA_DIR=<scratch dir>` (honoured only with `HODOS_DEV=1`).
- To test against a real DB, copy `wallet.db`, `wallet.db-wal` **and** `wallet.db-shm` together into `<scratch>\wallet\`, run on the copy, delete it afterwards, and check the real files' sizes/timestamps are unchanged.
- spv mode (`HODOS_CHAIN_MODE=spv`) makes no MessageBox/PeerPay traffic and no public-indexer calls, so a run on a copy cannot acknowledge real messages. Public mode does both.
- Stop only your own wallet process, matched by exe path (`*ChainBrowsers*Hodos-Browser*rust-wallet*target*debug*hodos-wallet.exe`); never by image name (the user's installed Hodos uses the same name).
- Build with `cargo` from bash (it is not on the PowerShell PATH); a running wallet locks `target\debug\hodos-wallet.exe`, so stop it before rebuilding.

## Verified findings (Oct 2026)

- **Browsers talk only to Arcade** (`:8080` API, `:8083` chaintracks headers, `:8082` SSE), never to Teranode. Arcade has no raw-tx, block, UTXO, address or outspend endpoint, so in spv mode outputs and parent txs arrive in BEEFs (`internalizeAction`) and are cached; address lookups return errors, never empty lists.
- **Arcade `POST /tx` accepts raw or Extended Format only, not BEEF.** Hodos converts BEEF to EF (needs the parents in the BEEF). It answers `202`; a coinbase an earlier run already spent is accepted for processing and then `REJECTED`, so wait for a network status before trusting it.
- **Arcade embeds go-chaintracks** (stores and serves headers, bulk `/headers`); no separate block-headers-service or chaintracks service is needed.
- **Arcade SSE** is a separate listener (default `:8082`, published by spv-testnet as `ARCADE_SSE_PORT`): frames `id:` / `event: status` / `data: {txid, txStatus, ...}`, `: keepalive` every 15 s, MINED frame carries `merklePath`, `Last-Event-ID` replay is best-effort. Only txs submitted with the same `X-CallbackToken` produce events.
- **First-seen:** a conflicting tx is `REJECTED` and the first stays `SEEN_ON_NETWORK`; Arcade never flags the first as a double-spend on a single node. A child of an unmined parent stays `ACCEPTED_BY_NETWORK` until a block.
- **After a machine restart the stack is down** (Docker Desktop is not running and some containers come back half-started): start Docker Desktop, then `stack.ps1 up -NoMine` in the spv-testnet repo (add the miner back with `docker start cb-block-generator`).
- **The stack's `cb-block-generator` mines every few seconds.** Scenarios that need an unmined tx (`fund-unmined`, `zero-conf`, `push-fallback`) must `docker stop cb-block-generator` first and mine by hand; restart it after.
- Arcade's fee policy reports 0 sat/KB, which Hodos's 100–10,000 sanity range rejects (it falls back to its default rate). Hodos derives mainnet-format addresses; the harness pays output scripts, not address strings.
- The balance cache is 60 s and `internalizeAction` does not invalidate it in public mode (spv mode does).
- In spv mode a MINED tx is confirmed only when a proof that verified against the wallet's own header chain is stored. A proof the header chain cannot judge yet (sync trails Arcade's MINED event by seconds) is **held** in the V27 `pending_proofs` table, never in `proven_txs` (every reader of that table treats a row as verified), and is verified locally after the next header sync with no re-fetch; wrong proofs are dropped, 6 h expiry. Push events carry the MINED `merklePath` into the same table. Header sync runs every 30 s, the proof poll every 60 s.

## Where things are

- `docs/hodos-spv.md`: how to run Hodos in spv mode, push, zero-conf, known gaps.
- `tests/hodos-spv/`: `fund.mjs`, `send.mjs`, `fund-unmined.mjs`, `zero-conf.mjs`, `push-fallback.mjs` (+ `proxy.mjs`, `lib.mjs`). `fund-unmined` and `push-fallback` need the wallet started with `HODOS_ZERO_CONF=off` (they time the proof path).
- Hodos code: `rust-wallet/src/{chain_mode,header_chain,header_sync,arcade_push,zero_conf}.rs`, `monitor/task_{sync_headers,recheck_proofs,push}.rs`, `services/providers/{arcade,chaintracks,spv_no_indexer}.rs`; layer docs in the Hodos repo's `rust-wallet/src/CLAUDE.md`.
