# Could the wallet<=>browser interface be much simpler?

Finding, 2026-10-05. Both browsers expose the full 28-method BRC-100 `WalletInterface` to web pages. This note asks what BOLT needs from that interface and what a simpler one would look like. It is the companion to `simplification.md` (the wallet core) and `bolt-store-review.md` (the DB schema: a token store versus the BRC-100 metadata layer).

**Short answer: yes, and BRC-100 is the wrong shape in both directions.** BOLT, as b017 defines it, needs five things from a wallet: a key, a signature over a digest, the wallet's verified headers, a broadcast, and somewhere to keep token packages. BRC-100 offers the first three, has no call for the last two, and carries about 22 methods BOLT never touches. Its transaction builder (`createAction`) cannot build a token transaction, because the covenant fixes the layout the wallet would want to choose.

**Basis:** a full read of b017 on branch `auth-bolt-plus-zf` at `9e2d8bf` (all source, docs, tests and scripts), a line-count map of the page interface in both browsers, and a first implementation, `packages/bolt`, run headless and live on Hodos with Arcade. See "Built so far" and "Not checked".

## What b017 requires

| Fact | Where |
|---|---|
| A token is a 1-sat output locked to a covenant that names an owner `pubKeyHash` and an `issuerPubKey`. Three types: `SimpleMultiBOLT` (fungible), `MinSimpleBOLT` (NFT), `AuthBOLT` (NFT plus up to 75 bytes of `authOrMiscData`). | `src/lib/scanner/fingerprints.ts`, `src/tokens/templates/` |
| A transfer is two transactions, commit then settle. **The current owner signs both.** The recipient supplies only a 20-byte `pubKeyHash`. | `test/helpers/minSimpleChain.ts` (`buildChain`), `src/tokens/MultiBOLT.ts:99-146` |
| The covenant fixes the transaction: version 2, inputs `[token, proof?, one funding?]`, outputs `[token(s), proof(s), one P2PKH change?]`. The funding outpoint and the change output are arguments of the unlock script, and the covenant hashes the outputs and the inputs. | `src/lib/single/singleSpend.ts`, `docs/formal-proof.md` Lemma 2 |
| The owner's signature is ECDSA, `SIGHASH_ALL\|FORKID`, over a preimage b017 assembles itself. b017 takes a raw `PrivateKey` today; a per-operation signer is on its roadmap. | `src/lib/boltLib.ts` (`createSignature`), `docs/ROADMAP.md` |
| `MinSimpleBOLT` and `AuthBOLT` spends may be **unfunded**: no funding input, no fee, never mined. An unfunded commit creates value (1 sat in, 2 out), so it cannot be broadcast at all. `SimpleMultiBOLT` always needs funding and change. | `test/lib/minSimpleZF.test.ts`, `test/scanner/valueConservation.test.ts` |
| A token travels as a package: the anchor (the previous settle, or the mint) plus the commit and settle standing on it, as Atomic BEEF over BEEF V2. | `README.md` "Receiving a token off-chain", `src/lib/scanner/beef.ts` |
| The receiver runs `verifyAndBroadcast`: it executes the scripts, checks the issuer against a key the caller trusts, checks the anchor's merkle path against the caller's headers, and hands the anchor to the caller's broadcaster. | `src/lib/scanner/verifyEvents.ts` |
| Offline checking reaches one event back. A forgery two events back passes offline and is caught only when the network rejects the anchor. | `test/scanner/anchorShapes.test.ts` ("THE LIMIT") |
| b017 never touches the network and stores nothing. | `README.md` |

## What the wallet must provide, and whether BRC-100 does

| Need | b017 hook | BRC-100 today |
|---|---|---|
| The owner key | a public key, hashed to the `pubKeyHash` | `getPublicKey`: yes |
| A signature over a 32-byte digest by that key | the signer in each unlock template | `createSignature` with `hashToDirectlySign`: yes in both (Hodos `handlers.rs:3667`; bsv-browser lists it in `vault/guard.ts:96`). The wallet signs blind: it cannot tell the user what the digest means. |
| The wallet's own headers | `isKnownBlockRoot(root, height)` or a `chainTracker` | `getHeaderForHeight`: yes, and both browsers answer from their verified chain in spv mode |
| Broadcast one given transaction and report accepted, already seen or rejected | `AnchorBroadcaster` | **No method.** `createAction` broadcasts only what it builds. |
| Keep token packages | none (the caller's job) | **No fit.** An unfunded event is never mined, so it cannot enter as a proven BEEF. The wallet's copy is the only copy. |
| Funding for a mint, any fungible operation, or an anchor | one P2PKH output the token key can spend | `createAction` with a P2PKH output, as the cross-wallet e2e already does |

`createAction` and `signAction` are not on this list for the token transactions themselves. A BRC-100 wallet picks its own inputs, adds its own change outputs and may reorder outputs. The covenant allows exactly one funding input and one change output in fixed positions. So under BRC-100 the page would build every token transaction itself and use the wallet only as a blind signer.

## What each browser carries for the page interface

Line counts from the first pass (`wc -l`, section sizes estimated from function positions).

| | Hodos | bsv-browser |
|---|---|---|
| Entry point | `CWIShimScript.h` 1,128 (about 730 are the legacy `window.yours` layer); `HttpRequestInterceptor.cpp` 6,184 | `utils/webview/cwiProvider.ts` 99; one 28-case switch in `app/index.tsx:1421-1458` |
| Method handlers | about 10,950 in `handlers.rs`, 3,780 in `certificate_handlers.rs` | in the toolbox bundle (a dependency) |
| Permission layer | engine and service about 6,000; manifest consent about 2,110 (two parsers); approval UI 3,704 | `WalletPermissionsManager` 3,444 lines of bundle, most prompts already off; vault guard 670 |
| Never called by BOLT or the tests | certificates and discovery (about 9,300 with overlay publish), encrypt/decrypt 540, HMAC 625, key linkage 435, `verifySignature`, `signAction`, `abortAction`, `relinquishOutput`, BRC-103 server auth about 400 | the same methods, reachable but unused |

The two are different problems. Hodos owns its code and could delete it. bsv-browser's is a dependency, so "simpler" there means exposing less.

## A simpler interface

Two layers, with b017 between them.

**Page to browser** (what a site calls):

- `getKey()`: a public key to receive at.
- `list(issuer?)`: tokens held.
- `receive(package)`: verify with the wallet's headers and broadcaster, then keep.
- `transfer(token, toPubKeyHash, amount?)`: returns the package for the recipient.
- `present(token, data)`: an AuthBOLT call that carries the site's data (up to 75 bytes, a challenge) in an unfunded commit and settle and returns the package. Nothing is broadcast and the token stays held, so it can be presented again. This is what stands in for BRC-100's certificate and auth methods (confirmed as the intent, 2026-10-05).
- `verify(package)`: what the site's side runs on that package.
- BSV payments: the two calls the e2e uses today (pay to a script, internalize a BEEF).
- `getHeight`, `getHeaderForHeight`.

**BOLT handler to wallet core** (never visible to pages): public key, sign digest, `isValidRootForHeight`, broadcast, fund one P2PKH output, store.

The wallet then knows what it signs and can show it. Blind digest signing stays off the page API.

**Where b017 runs.** In bsv-browser it can run in the app: it is TypeScript with `@bsv/sdk` as its only dependency. Hodos's wallet is Rust, so b017 either runs in the browser's JavaScript layer with the Rust wallet behind the core calls, or is ported. A port includes a script interpreter, because the scanner executes scripts.

## Three ways to get there

| | What | For | Against |
|---|---|---|---|
| A. Subset | Keep `window.CWI`; allow `getPublicKey`, `createSignature`, `createAction`, `internalizeAction`, `listActions`, `getHeight`, `getHeaderForHeight`; refuse the rest. Add one call to broadcast a transaction. | Small and reversible: the switch in `app/index.tsx`; in Hodos the `METHODS` list, the endpoint table and one check in `domain_trust_mw`. | The page builds token transactions and the wallet signs blind. No store for packages. Deletes nothing. |
| B. Purpose-built | The two layers above. | The wallet sees what it signs. Covers broadcast and storage. Removes the two workarounds the e2e needs (the one-off sender key, the Hodos payment modal with no price). | Existing BRC-100 sites stop working unless the old interface stays beside it. b017 has to run in or next to each wallet. |
| C. Removal in Hodos | B, then delete what nothing reaches. | The only option that shrinks code. | Forks `arcade-provider` further from `staging`. Most of what goes is route handlers; the code under them stays (see the trace below). |

**Recommendation:** B beside the existing interface, which is what `packages/bolt` starts (decided 2026-10-05: BRC-100 stays). A remains available as a way to measure what sites use. C is a product decision.

## What Hodos itself uses of the 33 page routes

Traced by search across the frontend, the C++ layer and the Rust wallet (28 BRC-100 methods plus `/.well-known/auth`, `/processAction` and the three message routes). Nothing was run.

| Used by Hodos's own features | How |
|---|---|
| `getPublicKey` | the wallet panel calls the route (identity key, five places) |
| `listCertificates`, `relinquishCertificate` | `CertificatesTab.tsx` calls the routes |
| `createAction` | called as a function by `/transaction/send`, PeerPay send, 402 pay, paymail send and certificate publish |
| `signAction` | called by `create_action_internal`, so it is on every spend |

The other 28 routes are reached only by pages. The C++ layer never calls a BRC-100 route itself; its 402 chain uses separate `/wallet/*` routes.

Removing a page-only handler does not remove what is under it. PeerPay, AuthFetch, certificate publish and the identity resolver share the BRC-2 encryption, the HMAC and signature helpers and the certificate parser and verifier. What has no other user at all: the two key-linkage handlers with `key_linkage.rs`, `proveCertificate` with its keyring code, `relinquishOutput`, `listActions`, and the three local message routes.

So option C saves less than the handler line counts suggest. The certificate subsystem in particular stays while Hodos keeps its certificate tab, identity publish and recipient lookup.

Four loose ends the trace turned up, none acted on: the legacy shim's `broadcast` falls back to `/wallet/broadcast`, which is not registered; `message_relay.rs` is not compiled; `create_certificate_transaction` has no callers; the `derived_key_cache` is written and never read.

## Built so far

`packages/bolt` implements the two layers for the NFT family (`MinSimpleBOLT`, `AuthBOLT`): mint, transfer, receive, present, verify. Its wallet core runs on an unchanged BRC-100 wallet plus Arcade, so it sits beside the existing interface. It signs through the wallet (`createSignature`), never holding a key.

| Run | Result |
|---|---|
| Headless, 9 tests: real b017, the SDK's `ProtoWallet` as the BRC-100 wallet, a pretend chain that refuses what a node would | pass |
| Live: a Hodos wallet in spv mode as issuer, through its BRC-100 HTTP interface, with Arcade. Mint, transfer (commit and settle), receive, present with a 32-byte challenge, verify, foreign issuer refused | pass, twice |

The live run used three wallet methods: `getPublicKey`, `createSignature`, `createAction`. Arcade took the mint, commit and settle in Extended Format and gave each a network status.

Not built: the injection of `window.BOLT` in either browser, fungible tokens, a durable store. See `packages/bolt/README.md`.

## What it costs

- **Backup becomes mandatory for tokens.** An unfunded AuthBOLT event exists only in the holder's wallet. This is stricter than the BRC-29 recovery constraint in `simplification.md`.
- **Someone must supply the trusted issuer key.** `verifyEvents` accepts any issuer unless given one. Whether the page or the wallet holds that list is undecided.
- **b017 is beta (`0.0.0-b2`).** Two fingerprints have changed since b1, and tokens minted on old bytecode must be reissued. Pin the version.
- **Still needed:** origin approval, a spending prompt, and the origin rules.
- **Patent and licence:** `docs/formal-proof.md` records a pending patent (GB2318902.0); the licence is Open BSV v5.

## Two bsv-browser findings on the way

Both were confirmed by reading the code (toolbox bundle 2.14.3 and the app); neither was reproduced on a device.

**A site manifest can hang wallet calls.** `seekGroupedPermission` is on (`WalletContext.tsx:1780`) and no handler for grouped requests is bound anywhere. Two paths wait on a promise only that handler can settle, with no timeout:

- a page's `createAction` that spends, when the site's `/manifest.json` declares `groupPermissions.spendingAuthorization` and the origin holds no sufficient spending token;
- a page's `waitForAuthentication`, when the manifest declares any group permission the origin does not hold.

The stuck flow holds a per-origin lock, so later permission requests from that origin block too. A site with no manifest, or no `groupPermissions`, is unaffected. No funds move.

**A page chooses which site a 402 payment is charged to.** The app handles a `PAYMENT_REQUIRED` message before it checks the frame's origin (`app/index.tsx:1322-1345`, origin check at 1377), and passes the page-supplied `msg.url` to the payment handler, which takes the originator from that URL (`bsvPaymentHandler.ts:162`). A page on one site can therefore have the wallet spend as another site: against that site's spending allowance with no prompt, or under the auto-approve threshold. The payment goes to a key derived from a server key the page supplies; whether the page can then spend it was not determined. The handler also uses the unguarded wallet, but that alone bypasses only one guard rule of little effect. Fix direction: require `msg.url` to match the verified frame origin.

## Not checked

- **`createAction` for a token transaction.** Not attempted. The claim that it cannot build one comes from reading both sides; `packages/bolt` builds token transactions itself and uses `createAction` only for a funding output.
- **A header-proven anchor, live.** The live run's anchors were unmined and accepted by broadcast. The path where an anchor is proven by the wallet's headers (`getHeaderForHeight`) ran only in b017's own tests, not here.
- **bsv-browser as the wallet.** The live run used Hodos only.
- **`@bsv/sdk` versions.** b017 wants `^2.1.6`; what bsv-browser ships was not compared.
- **Not read in b017:** the PDFs under `research/` and the hex and JSON fixtures.
