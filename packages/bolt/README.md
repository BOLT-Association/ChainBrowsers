# BOLT handler

A small interface for BOLT tokens ([b017](https://github.com/BOLT-Association/b017)) that a browser offers to pages beside BRC-100. The reasoning is in [`docs/interface-simplification.md`](../../docs/interface-simplification.md).

## What a page calls

| Call | Does | Asks the user |
|---|---|---|
| `getKey()` | the public key and `pubKeyHash` to receive tokens at | no |
| `list()` | tokens held | no |
| `verify(package, { issuer? })` | check a package another wallet produced | no |
| `receive(package)` | verify a transfer addressed to this wallet and keep the token | yes |
| `present(id, { data, to? })` | show an AuthBOLT token with up to 75 bytes of data (a site's challenge); nothing is broadcast and the token stays held | yes |
| `transfer(id, toPubKeyHash)` | a funded commit and settle, broadcast; the token leaves the wallet | yes |
| `mint({ type })` | mint a token with this wallet as issuer | yes |

A package is `[beef(commit), beef(settle)]`: two Atomic BEEF hex strings, with the anchor (the mint or settle they stand on) inside.

## How it is put together

```
page  --pageClient-->  browser transport  --dispatcher-->  BoltHandler  -->  b017
                                                                |
                                                           wallet core
```

- `src/handler.js`: the operations above.
- `src/nft.js`: the transaction layouts for `MinSimpleBOLT` and `AuthBOLT`.
- `src/signer.js`: signs through a wallet that keeps its key (two passes: record the digests, replay the signatures).
- `src/core.js`: the six things the handler needs from a wallet, and `brc100Core`, which provides them from a BRC-100 wallet (`getPublicKey`, `createSignature`, `getHeaderForHeight`, `createAction`) and Arcade.
- `src/page.js`: `pageClient` (what a page sees) and `dispatcher` (which methods a page may call, and the prompt text).

## Run

```bash
npm run vendor      # builds b017 at the pinned commit into vendor/ (b017 publishes only dist/)
npm install
npm test            # headless: real b017, the SDK's ProtoWallet as the BRC-100 wallet, a pretend chain

# live: stack up, a funded Hodos wallet on :31401 in spv mode (docs/hodos-spv.md)
node live/hodos.live.mjs
```

## Not done

- **Browser wiring.** Neither browser injects `window.BOLT` yet. The live test drives Hodos through its BRC-100 HTTP interface from Node.
- **Fungible tokens.** `SimpleMultiBOLT` mint / whole-token transfer / receive / balance are handled (`src/fungible.js`), driving b017's token class with a wallet `Signer` (the `async-signer` branch). A held token is reconstructed from its stored BEEF to transfer onward. **Partial-amount payments (split) and merge are not handled yet** — a fungible transfer moves the whole token; to send part of a balance you need split.
- **Backup.** A durable, type-agnostic store exists (`sqlStore` over a SQL adapter; `nodeSqliteStore` for Node; `memoryStore` for tests), keeping the BEEF plus the full anchor (its tx, kind, network status, proof state, and the provenance anchor). A held token's package is still the only copy of an off-chain event, so a browser must also back it up. The proof-refresh loop (`setAnchorProof` on a later poll/reorg) is a hook, not yet wired.
- **Proof upkeep.** A held token's BEEF keeps its unmined ancestors; nothing replaces them with merkle paths once they are mined.
