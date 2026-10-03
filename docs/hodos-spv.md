# Running Hodos in spv mode against the local chain

`HODOS_CHAIN_MODE=spv` makes the Hodos wallet use **only** Arcade (broadcast, tx status, BUMPs, fee policy) and Arcade's chaintracks (headers, verified by the wallet's own header chain). It never contacts public indexers and never talks to Teranode. Outputs and parent transactions reach the wallet inside BEEFs (`internalizeAction`), not by address lookup. Arcade embeds go-chaintracks and stores/serves the headers itself, so no separate block-headers-service or chaintracks service is needed.

## 1. Chain stack

```powershell
cd <spv-testnet>\stack
.\stack.ps1 up        # Arcade :8080, chaintracks :8083, Teranode RPC :29292 (harness only)
```

## 2. Wallet (throwaway data directory)

`HODOS_DATA_DIR` relocates the wallet DB and logs. It is honoured only with `HODOS_DEV=1`, so a test wallet never touches `HodosBrowserDev` or `HodosBrowser`.

```powershell
cd browsers\Hodos-Browser\rust-wallet
cargo build --bin hodos-wallet
$env:HODOS_DEV = "1"
$env:HODOS_DATA_DIR = "C:\temp\hodos-spv-wallet"      # an empty directory, or a COPY of a wallet DB
$env:HODOS_CHAIN_MODE = "spv"
$env:HODOS_ARCADE_URL = "http://localhost:8080"
$env:HODOS_CHAINTRACKS_URL = "http://localhost:8083/chaintracks/v2"
.\target\debug\hodos-wallet.exe                         # listens on 127.0.0.1:31401
```

The directory must contain `wallet\wallet.db` (copy `wallet.db`, `-wal` and `-shm` together to test against a real DB). Create a wallet once: `curl -X POST localhost:31401/wallet/create -H "content-type: application/json" -d "{}"`.

Startup refuses `spv` without both URLs, and refuses an unrecognised `HODOS_CHAIN_MODE`. In spv mode the wallet makes **no MessageBox (PeerPay) traffic** (polling and outbox retries are off), so running it on a copy of a real wallet cannot acknowledge real messages. The log should contain no `AuthFetch` lines.

## 3. Fund and spend

```bash
cd tests/hodos-spv && npm install
node fund.mjs            # coinbase -> BRC-29 output, Arcade + mine, internalize as Atomic BEEF (tampered BUMP rejected first)
node send.mjs            # wallet spends, Arcade broadcast, mine, wallet verifies the proof, tx completed

docker stop cb-block-generator          # the stack's miner would mine the tx within seconds
node fund-unmined.mjs                   # BEEF whose subject is NOT mined: not spendable, then mined, proof verified, output promoted, spend succeeds
docker start cb-block-generator
```

The harness uses Teranode RPC only to mine and to pick a coinbase; the wallet never does.

## Push (Arcade SSE) and the polling fallback

Proofs normally arrive by polling (`TaskCheckForProofs`, every 60 s). With push on, Arcade's Server-Sent Events stream wakes that same task the moment a tx is mined, so a proof is verified, stored and the output promoted within seconds instead of up to about 90 s. Push never replaces polling and never stores anything itself: an event only triggers an immediate header sync and proof check (retried every 2 s while the header chain catches up to the block). Polling keeps its normal cadence, because a tx that is not registered under the wallet's token produces no events, Arcade's replay after a reconnect is best-effort, and a stream can be up but silent.

| Setting | Meaning |
|---|---|
| `HODOS_ARCADE_SSE_URL` | Arcade's SSE service (a separate listener, default port 8082; the stack publishes it as `ARCADE_SSE_PORT`). Push is on only when this is set (spv mode). |
| `HODOS_ARCADE_PUSH=off` | Switch push off even if the URL is set. Polling cannot be switched off. |

The callback token is `HMAC-SHA256(master private key, "hodos-arcade-callback-token-v1")`: stable across restarts, per wallet, not derivable from the public identity key. Every broadcast through Arcade carries it as `X-CallbackToken`; an internalized tx that is on the network but unproven is re-submitted once (Extended Format, idempotent) to subscribe it.

Measured on the local stack (time from the block being mined to the output being spendable; the proof task polls every 60 s):

| Stream condition | Time | Delivered by |
|---|---|---|
| Working | 0.7 s | push (MINED event woke the proof check) |
| Refused (503) | 59.1 s | polling |
| Up but silent (keepalives only) | 62.5 s | polling |
| Dropped across the block, restored 4 s later | 8.7 s | reconnect + `Last-Event-ID` replay |

Fallback scenarios (`tests/hodos-spv/push-fallback.mjs`) run the unmined-subject flow with the stream working, refused, up-but-silent, and dropped across the block, and time how long after mining the output becomes spendable:

```bash
cd tests/hodos-spv
node proxy.mjs &                 # fault-injecting proxy: API + SSE on :8090, control on :8091
docker stop cb-block-generator
# start the wallet with HODOS_ARCADE_URL=http://localhost:8090 and HODOS_ARCADE_SSE_URL=http://localhost:8090
node push-fallback.mjs
```

## Things that behave differently from public mode

| Area | spv mode |
|---|---|
| Raw tx / outspend / UTXO-by-address | No source. Errors, never "not found" or an empty list. Data arrives in BEEFs; every tx in an internalized BEEF is cached in `parent_transactions` so its outputs can be spent later. |
| Internalized output | Marked confirmed at once if the BEEF carried a BUMP for that tx. If the subject was unmined it stays unconfirmed (not selectable) until `TaskCheckForProofs` stores a verified proof, which promotes it. |
| Proof storage / "completed" | A MINED tx is marked confirmed only once a proof that verified against the wallet's header chain is stored. Until the header chain has the block (sync every 30 s, proof task every 60 s) it stays pending and retries. |
| Broadcast | BEEF is converted to Extended Format for Arcade (it rejects BEEF); a BEEF with a missing parent is an error. |
| `getHeight` / `getHeaderForHeight` | From the verified header chain only; 503/404 until synced. |
| MessageBox / PeerPay polling | Off. |
| Double-spend suspects | Stay suspected (Arcade has no per-input spent check); the 6-hour auto-confirm is skipped. |
| Price | Still fetched from public sources (not chain state). |

## Known gaps

- An internalized output whose tx never gets mined stays unconfirmed forever (safe, but never cleaned up; the phantom-output sweep needs a public lookup).
- Polling is not slowed down when push is healthy (a tx with no push registration would then wait longer). It could be, behind a setting, if Arcade load ever matters.
- Push has no browser-settings toggle yet (env only), because spv mode itself is env-only.
- `internalizeAction` does not invalidate the wallet's balance cache in public mode (spv mode does, after confirming).
- Arcade reports a 0 sat/KB policy, which Hodos's fee sanity range rejects, so it falls back to its default rate.
- In public mode a proof that fails verification still marks the tx confirmed (existing behaviour, left alone).
