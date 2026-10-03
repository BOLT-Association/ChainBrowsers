# Running Hodos in spv mode against the local chain

`HODOS_CHAIN_MODE=spv` makes the Hodos wallet use **only** Arcade (broadcast, tx status, BUMPs, fee policy) and Arcade's chaintracks (headers, verified by the wallet's own header chain). It never contacts public indexers and never talks to Teranode. Outputs and parent transactions reach the wallet inside BEEFs (`internalizeAction`), not by address lookup.

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
$env:HODOS_DATA_DIR = "C:\temp\hodos-spv-wallet"      # any empty directory
$env:HODOS_CHAIN_MODE = "spv"
$env:HODOS_ARCADE_URL = "http://localhost:8080"
$env:HODOS_CHAINTRACKS_URL = "http://localhost:8083/chaintracks/v2"
.\target\debug\hodos-wallet.exe                         # listens on 127.0.0.1:31401
```

Create a wallet once: `curl -X POST localhost:31401/wallet/create -H "content-type: application/json" -d "{}"` (the response contains a throwaway mnemonic).

Startup refuses `spv` without both URLs, and refuses an unrecognised `HODOS_CHAIN_MODE`.

## 3. Fund and spend

```bash
cd tests/hodos-spv && npm install
node fund.mjs        # spend a coinbase into a BRC-29 output, Arcade + mine, internalize as Atomic BEEF
node send.mjs        # wallet spends, Arcade broadcast, mine, wallet verifies the proof and marks it completed
```

`fund.mjs` first sends a copy of the BEEF with a tampered BUMP and requires `ERR_PROOF_NOT_VERIFIED`. The harness uses Teranode RPC only to mine and to pick a coinbase; the wallet never does.

## Things that behave differently from public mode

| Area | spv mode |
|---|---|
| Raw tx / outspend / UTXO-by-address | No source. Errors, never "not found" or an empty list. Data arrives in BEEFs. |
| Internalized output | Marked confirmed at once if the BEEF carried a BUMP for that tx (the verified proof is the confirmation). A BEEF whose subject has no BUMP stays unconfirmed. |
| Broadcast | BEEF is converted to Extended Format for Arcade (it rejects BEEF); a BEEF with a missing parent is an error. |
| `getHeight` / `getHeaderForHeight` | From the verified header chain only; 503/404 until synced. |
| Proof storage | A proof is not stored until the header chain has the block (sync runs every 30 s, proof task every 60 s), so a fresh spend takes a couple of ticks to show `completed`. |
| Double-spend suspects | Stay suspected (Arcade has no per-input spent check); the 6-hour auto-confirm is skipped. |
| Price | Still fetched from public sources (not chain state). |

## Known gaps

- A BEEF whose subject tx is *not* yet mined is internalized unconfirmed and nothing in spv mode promotes it to spendable when its proof arrives later.
- `internalizeAction` does not invalidate the wallet's balance cache in public mode (spv mode does, after confirming).
- Arcade reports a 0 sat/KB policy, which Hodos's fee sanity range rejects, so it falls back to its default rate.
