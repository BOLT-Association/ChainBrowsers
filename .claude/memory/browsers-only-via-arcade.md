---
name: browsers-only-via-arcade
description: Browsers (Hodos, bsv-browser) must reach the chain only through Arcade (:8080) and its chaintracks (:8083), never Teranode directly
metadata:
  type: feedback
---

User decision (2026-10-03): browsers will not interface with Teranode directly (no asset server :28090, no RPC :29292). Only Arcade's API, its chaintracks server and its SSE service (:8082).

Arcade offers: POST /tx, GET /tx/{txid} (status + BUMP, only for txs submitted to it), /policy, /v1/policy, chaintracks headers (/tip, /height, /header/height|hash, /headers, streams). It has NO raw-tx, block, UTXO, address-history or outspend endpoint.

**Why:** keeps browsers on the same surface a real deployment gives them; Teranode is infrastructure behind Arcade.
**How to apply:** raw-tx and UTXO discovery cannot come from the stack. Use the SPV model (outputs arrive via internalizeAction with BEEF; parents/BUMPs travel in the BEEF; wallet's own `outputs` table is the source of truth; spent-ness from Arcade tx status / competingTxs). Test harnesses in spv-testnet may still use Teranode RPC to mine and fund. See [[chainbrowsers-status]].
