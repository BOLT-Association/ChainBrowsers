# The wallet store, reviewed against what BOLT needs

Review, 2026-10-05. The Hodos wallet DB is 36 live tables (`rust-wallet/src/database/CLAUDE.md`). bsv-browser carries the same families through the toolbox's SQLite store. Most of it is the generic BRC-100 metadata layer — actions, baskets, tags, labels, certificates. A BOLT token is not any of those: it is a self-contained BEEF package (anchor + commit + settle). `packages/bolt` already shows the record it needs: `{id, type, issuer, owner, vout, beef}`. This note classifies the schema against that, and proposes a lean store.

Companion to `interface-simplification.md` (the page interface) and `simplification.md` (the wallet core).

## The three buckets

**A. Money + SPV core — keep (BOLT uses it too).**

| Table(s) | Why BOLT needs it |
|---|---|
| `wallets`, `users` | the master key BOLT derives its token key from, and signs with |
| `outputs` | funding. A mint, any fungible op, and a transfer's commit/settle all need one P2PKH input; `createAction` draws it from here |
| `transactions`, `proven_txs`, `proven_tx_reqs`, `pending_proofs` | a funded broadcast's status and its merkle proof; the same path confirms a token's anchor |
| `header_chain` | verifying a received package's anchor against the wallet's own headers — the heart of SPV |
| `parent_transactions` | cached parents so a received output (or token input) can be spent later with no indexer |
| `settings` | chain, fee rate, caps |

**B. BRC-100 feature layer — defunct for BOLT, load-bearing for BRC-100.** A token never touches these. They stay only because the wallet panel, send, PeerPay, 402 and certificate publish do (the Hodos caller trace in `interface-simplification.md`).

| Table(s) | Serves | BOLT equivalent |
|---|---|---|
| `output_baskets` | `listOutputs`/basket organisation | none — a token is addressed by its outpoint, not filed in a basket |
| `output_tags`, `output_tag_map` | output tagging | none |
| `tx_labels`, `tx_labels_map` | `listActions` filtering | none — the handler holds its tokens directly |
| `transaction_inputs`, `transaction_outputs` | the BRC-100 action's input/output detail | none — a token's detail is the BEEF itself |
| `certificates`, `certificate_fields` | BRC-52 certificates | **AuthBOLT** — an issuer-signed token carrying up to 75 bytes is the credential |
| `cert_field_permissions`, `domain_manifest_snapshots`, `domain_protocol_permissions`, `domain_basket_permissions`, `domain_counterparty_permissions` | the BRC-100 permission matrix (protocol/basket/counterparty/cert grants) | a far smaller model: per-origin approval + a spend cap for funded ops |
| `commissions` | Hodos's 1000-sat service fee | only if BOLT keeps a service fee |
| `peerpay_received`, `peerpay_pending_verification`, `peerpay_outbox`, `messages`, `relay_messages` | PeerPay (MessageBox) and the BRC-33 local relay | none in these tables — a BOLT package travels as BEEF over any transport; a delivery channel is still needed but it is not this |

**C. Dead or near-dead now — removable regardless of BRC-100 (each needs one confirmation first).**

| Table | Evidence | Confirm before removing |
|---|---|---|
| `derived_key_cache` | the caller trace found it written by `get_public_key` and read by nothing (no `FROM derived_key_cache`, no reader of the in-memory map) | the layer doc claims `sign_action` uses it — the trace contradicts that; settle which is right |
| `block_headers` | in spv mode `getHeight`/`getHeaderForHeight` answer from `header_chain`; this is the public-mode TSC cache | still used in public mode, so only dead if public mode goes |
| `messages`, `relay_messages` | back only the page-only `/sendMessage`,`/listMessages`,`/acknowledgeMessage`; no internal caller; the in-memory `message_relay.rs` is not even compiled | drop the three routes and these go |
| `engine_shadow_log` | already dropped in V23 | — |

## The lean store, if a wallet were BOLT + BSV payments only

About ten tables instead of 36:

```
wallets            -- encrypted mnemonic / master key          (unchanged)
utxos              -- outputs, minus basket_id/tags/purpose/output_description/custom_instructions
txs                -- transactions, minus reference_number/description/labels/commission FK
tokens             -- NEW: the BOLT store (see below)
headers            -- header_chain
proofs             -- proven_txs
pending_proofs     -- pending_proofs
parent_txs         -- parent_transactions
origins            -- domain_permissions, minus the four sub-permission child tables; keep (origin, approved, spend_cap)
settings           -- a handful of rows
```

Dropped: `output_baskets`, `output_tags`, `output_tag_map`, `tx_labels`, `tx_labels_map`, `transaction_inputs`, `transaction_outputs`, `certificates`, `certificate_fields`, the four permission sub-tables, `cert_field_permissions`, `domain_manifest_snapshots`, `commissions`, the three `peerpay_*`, `messages`, `relay_messages`, `block_headers`, `derived_key_cache`, `monitor_events`, `sync_states`. That is ~26 tables and, with them, baskets/tags/labels/actions-metadata/certificates/peerpay as concepts.

`tokens` is the only new table, and it is small:

```sql
CREATE TABLE tokens (
  outpoint     TEXT PRIMARY KEY,   -- "<txid>.<vout>", the id packages/bolt already uses
  type         TEXT NOT NULL,      -- 'MinSimpleBOLT' | 'AuthBOLT' | 'SimpleMultiBOLT'
  issuer       TEXT NOT NULL,      -- 33-byte issuer pubkey (hex)
  owner_pkh    TEXT NOT NULL,      -- the wallet key that holds it (hex)
  status       TEXT NOT NULL,      -- 'held' | 'spent'
  beef         BLOB NOT NULL,      -- Atomic BEEF: anchor + commit + settle
  created_at   INTEGER NOT NULL
);
```

That is exactly the `packages/bolt` store interface (`put`/`get`/`list`/`delete` over `{id,type,issuer,vout,beef}`), one-to-one. Funding, headers and proofs come from the money/SPV core above, which BOLT shares with BSV payments.

## What this actually licenses right now

- **Build the `tokens` store as additive.** It touches none of bucket A or B, so `packages/bolt` gets a durable store (replacing `memoryStore`) with no schema removal and no risk to BRC-100. This is the shippable piece.
- **The bucket-C cleanups** are small and independent of BOLT; worth doing on their own merits once each one's single open question is settled.
- **Bucket B cannot be dropped while BRC-100 stays.** The lean schema above is the target *if* BRC-100 is ever retired (option C in `interface-simplification.md`), measured, not a change to make now.

## Not done / not mine to do

- ⛔ The Hodos invariant is "do not change the wallet DB schema without asking". Everything here is a proposal; nothing was changed.
- bsv-browser's store is the toolbox's; it cannot be reshaped without forking the toolbox. There, "lean" means the BOLT handler keeps its token records in its own table and ignores the toolbox's basket/action tables — the same additive move.
- The `derived_key_cache` reader question (doc vs trace) is unresolved; resolve it before counting that table dead.
- `monitor_events`, `sync_states`, `transaction_inputs/outputs` were classified from the schema roster and caller trace, not a full read of every writer.
