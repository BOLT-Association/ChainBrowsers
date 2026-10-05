# Could the two wallets be much simpler?

Finding, 2026-10-04. Hodos and bsv-browser both use BRC-100 `internalizeAction` and BRC-29 payments by default. This note compares their architecture and asks whether it could be much simpler.

**Short answer: yes, though not by changing BRC-100 or BRC-29.** The complexity in both wallets comes from the machinery that exists because money can also arrive in other ways, and from running two chain backends (public and spv) side by side.

**Basis:** the repo docs and the layer docs (`docs/hodos-spv.md`, `docs/bsv-browser-spv.md`, the Hodos `rust-wallet/CLAUDE.md` and `rust-wallet/src/CLAUDE.md`, the fork's `docs/SPV_MODE.md`). It is not a line-by-line read of `handlers.rs` or the toolbox.

## How they compare today

| | Hodos | bsv-browser |
|---|---|---|
| Wallet core | Hand-written Rust server (110 routes, 16 background tasks, own schema) | Reference toolbox (`@bsv/expo-wallet-toolbox`) as a dependency, hardened through a `patch-package` patch |
| Ways money gets in | Several: `internalizeAction`, PeerPay auto-accept (own storage path, `store_derived_utxo`), address sync from an indexer, legacy BIP32 | One: every route (page bridge, in-app, nearby, token) ends in `wallet.internalizeAction` |
| Chain services | 9 providers in 7 fallback chains, plus spv mode on top | Toolbox provider collections, plus spv mode on top |
| Proof bookkeeping | `proven_txs`, `proven_tx_reqs`, `pending_proofs`, tx status, output flags | The toolbox's equivalent tables |

Hodos follows the toolbox's design (same task and table names; its own rule is "port patterns, never code"), so this is one design implemented twice. That is why the spv hardening had to be built twice: as Rust modules in Hodos and as a TypeScript patch in bsv-browser.

## What a simpler design looks like

If a BEEF through `internalizeAction` is the only way an output enters, the wallet never has to ask anyone what it owns. The core shrinks to:

- **Keys:** BRC-42 derivation.
- **One store:** transactions with an optional merkle path, and outputs.
- **A verified header chain.**
- **One Arcade client:** broadcast, status, SSE.
- **One background loop:** sync headers, then resolve unproven transactions against them.

```
receive:  BEEF -> internalizeAction -> verify BUMPs against own headers
                                       (unmined txs: Arcade has seen them) -> store
send:     createAction -> sign -> Arcade (Extended Format) -> status / proof events
                                       -> verify against own headers -> store
```

Address sync, UTXO and outspend lookups, reconciliation against an indexer and most fallback chains then have no job. Spv mode already shows this: those paths just return errors there.

## What it costs

- **Recovery:** BRC-29 outputs cannot be found again from the mnemonic alone (the derivation depends on the sender's key and per-payment values), so a backup of the output set becomes mandatory. This is a hard constraint.
- **Address payments:** deposits to a plain address (from an exchange, say) need an indexer. They can live in an edge adapter that turns an address lookup into a BEEF and calls `internalizeAction`, so the core stays unaware.
- **Liveness:** one Arcade is a single point of failure for availability, not safety. Several Arcades behind one interface is still far simpler than nine different providers.
- **Not removed:** mainnet header rules, the wait for a proof, reorg handling, zero-conf policy and the permission layer all stay. A delivery channel for BRC-29 payments (MessageBox or direct) is still needed too.

## Recommendation, cheapest first

1. **Hodos: one receive path.** Route PeerPay and every other receive through `internalize_action`. Its layer doc already notes the PeerPay path carries a duplicated copy of the on-chain existence check.
2. **Both: make spv the core, not a mode.** Move the indexer features out to the BEEF-producing adapter. This is the big reduction, and it is a product decision rather than a technical one.
3. **bsv-browser: upstream the chain rules.** If the toolbox took the rules as a parameter instead of checking proof-of-work against the mainnet limit in three places (`ChaintracksServiceClient`, `hashToHeader`, the Arcade proof provider), most of the patch becomes configuration.
4. **Longer term: one shared core** for both browsers. bsv-browser already contains a Rust FFI crate (`native-engine-ffi`); what it covers has not been read.

bsv-browser is closer to the simple shape today. Hodos has more to remove because it grew from an address-and-indexer wallet.

## Not checked

- No code was measured: "most fallback chains have no job" and the list of removable parts come from the task and provider descriptions in the layer docs, not from a dependency trace.
- The toolbox's internal layering was not audited for what a single-store mobile wallet could drop.
- `native-engine-ffi` in bsv-browser was not read.
