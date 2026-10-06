# `window.BOLT` in the browser

The page-facing BOLT interface — `packages/bolt` — runs in a web page as `window.BOLT`, beside the
wallet's existing `window.CWI`. This doc covers the two browsers' ways of doing it and what has been
verified. The handler itself is documented by the code in `packages/bolt/src`.

## The two models

`page.js` is written for a **thin** page shim talking to a **trusted** handler on the browser's own
side: `pageClient` in the page, `dispatcher` plus a prompt that says what is being asked ("transfer
token X to Y") on the trusted side. That fits **bsv-browser**, whose wallet already runs in JS in the
app (see below).

**Hodos has no trusted JS runtime** (its wallet is Rust, its shell is C++), so it uses the **fat
page-side model**: the whole handler — `packages/bolt` + `b017` + `@bsv/sdk` — is bundled and injected
into the page, and everything it needs from outside the page goes through the wallet.

## Hodos

### What runs where

| In the page (the injected bundle) | In the wallet, over the existing `wallet_call` bridge |
|---|---|
| token logic (b017), building and checking transactions | keys, signatures, funding: `getPublicKey`, `createSignature` (`hashToDirectlySign`), `createAction` |
| | headers: `getHeaderForHeight` (the wallet's verified chain) |
| | the network: `POST /boltBroadcast` — submit a transaction, answer the network's verdict |
| | the tokens held: `POST /boltTokens` — the wallet's `bolt_tokens` table (V28) |

A page cannot reach the chain service itself (a site's CSP and CORS forbid it) and must not be where
tokens live (page storage belongs to one site), which is why the last two rows exist
(`rust-wallet/src/bolt.rs`, `database/bolt_token_repo.rs`; page side `src/wallet-rail.js`).

The token table is **append-and-retire** because its writer is page code: a row's token data (`beef`,
`type`, `issuer`, `amount`…) is written once and never overwritten, a spent row is marked `spent` and
kept, and there is no delete. The wallet bounds what is stored (`validate_row`) but cannot check a row
against its BEEF — it does not run the token scripts.

### Consent

The private key never leaves the wallet, and neither new endpoint spends coins. Consent is the
wallet's own, at **BRC-100 granularity**, not BOLT's:

- The site must be an approved domain (the connect prompt).
- Each signature asks *"\<site\> wants permission to use a protocol: bolt token (level 1)"* until the
  user gives that site a lasting grant. In the live run every signature prompted (18 prompts for one
  mint–present–mint–pay–pay flow, each answered "Allow once").
- Funding (`createAction`) is silent under the site's spending limits, like any payment.
- `/boltBroadcast` and `/boltTokens` have no prompt of their own: any approved domain can broadcast
  through the wallet, **read every token the wallet holds, add rows and retire them**. It cannot
  destroy or alter token data.

So a user never sees "transfer token X to Y"; once a site holds the `bolt token` protocol grant it can
sign any token operation silently. A prompt that states the operation needs the handler on the
trusted side, which is the bsv-browser model.

### Build

`packages/bolt/src/browser.js` exports `installBolt({ walletCall, trustedIssuers, target })`. `npm run
bundle` (`scripts/bundle-shim.mjs`) bundles it with esbuild into one IIFE (`dist/bolt-shim.js`,
~425 KB; b017's 128-bit balance arithmetic needs a `Buffer` polyfill, `scripts/shim-inject.js`) and
wraps it as a C++ header, `dist/BoltShimScript.h`.

The header holds the script as **separate ~16 KB string literals joined at runtime** by
`BoltShimScript()`: MSVC caps a string literal at about 16,384 bytes (error C2026; measured on VS2022
14.44, where a 16 KB literal compiles and a 24 KB one does not), and the cap also applies to the
concatenated result of *adjacent* literals. `dist/` is a build output; after changing the handler,
b017 or the bundler, run `npm run bundle` and copy the header to
`browsers/Hodos-Browser/cef-native/include/core/BoltShimScript.h` (checked into the Hodos repo).

In Hodos, `cef-native/src/handlers/simple_render_process_handler.cpp` includes the header and, in
`OnContextCreated`, injects `BoltShimScript()` right after `CWI_SHIM_SCRIPT`. It shares CWI's gate:
**main frames of external `https://` pages only** — an `http://` page, an iframe and a loopback page
get no `window.BOLT`. `installBolt` reads `window.__BOLT_CONFIG__.trustedIssuers` if the browser sets
it; a page can always name the issuer per call (`verify(pkg, { issuer })`).

### Verified

- **In the browser** (`packages/bolt/live/hodos-page.live.mjs`, 2026-10-06, regtest + Arcade): an
  https page in a Hodos tab has `window.BOLT`; the same page over http loads and has none (the
  control). From the page: `getKey`; mint an AuthBOLT and present it to a verifier outside the
  browser; mint a fungible token and pay part of it to a recipient outside the browser; reload the
  page and still hold, and spend, the tokens. That run covers `createSignature` with
  `hashToDirectlySign` from an external https origin, and both new endpoints over the IPC bridge.
  The page is served by the test itself on `https://bolt.test:8443` (self-signed; the browser is
  started with the name mapped to this machine), so it needs no internet.
- **The wallet rails over HTTP** (`live/hodos.live.mjs`): the issuer mints, transfers and pays through
  `/boltBroadcast` and `/boltTokens` on Arcade; V28 was applied to an existing wallet database.
- **Headless**: `test/browser.test.mjs` runs the real bundle in `node:vm` pages whose bridge is a fake
  wallet; the wallet's Rust side has unit tests for the table's rules, the network verdicts and the
  row checks.

### Open

- **Backup.** `bolt_tokens` is not in the wallet's backup (`backup.rs`). A recovered wallet has no
  BOLT tokens, and they cannot be re-derived from the mnemonic: the BEEF is needed.
- **Any approved site sees and can retire all tokens** (above). Scoping by site or by issuer, or a
  prompt on `/boltTokens`, is not built.
- **425 KB into every https main frame** at `OnContextCreated`; cost not measured. A small loader
  that evaluates the bundle on first use, or injection for opted-in sites only, would avoid it.
- **Relay note.** The Hodos commits touch `cef-native/**`; the two-platform workflow wants a relay
  round naming the files when this branch feeds `0.4.0`. macOS is not built or tested.

## bsv-browser

The model `page.js` was written for. The app's wallet already runs in JS, so the handler does too,
and the page holds nothing.

| In the page | In the app |
|---|---|
| a thin `window.BOLT` (top document only): each method posts `{ type: 'BOLT', id, method, args }` and waits for the reply | the handler and b017 (`vendor/bolt/bolt.js`, generated by `npm run bundle:rn`) |
| | keys, signatures, funding: the wallet, called with the app's admin originator, so the wallet's own prompts do not appear |
| | the network: Arcade, the URL and API key the app is configured with |
| | the tokens held: a SQLite file per wallet key and network (expo-sqlite, through the store's SQL adapter) |
| | **the prompt**, which says what is asked and for whom: *"shop.example asks to — pay 300 of token 02ab… to 03cd…"* |

`getKey`, `list` and `verify` do not ask; `receive`, `present`, `transfer`, `pay`, `melt` and `mint`
do, once each, in BOLT's terms. The origin in the prompt is the one the app resolved for the frame;
the page is never asked who it is. Every fragment of the prompt that comes from the page is clamped
to short printable ASCII (`page.js`), so a page cannot write its own sentence into it. Requests are
served one at a time. A declined request signs and broadcasts nothing.

App side: `utils/bolt/boltService.ts` (the service), `utils/webview/documentStartScript.ts` (installs
the provider after `window.CWI`), one branch in `app/index.tsx` (answers a BOLT message with a BOLT
reply, delivered like a wallet response). `@bsv/sdk` is not bundled: the app's own, patched SDK is
used, which is why the app has its own test.

Differences from Hodos that matter to a site: the page methods are the same, but here a request can
be declined by the user with the operation in front of them, tokens are not readable by other sites
without going through the same interface, and a page on `http://` gets `window.BOLT` too (the app
gives wallet access by origin, not by scheme; pages served from an IP address get none).

### Verified

- **In the app's test suite** (`__tests__/bolt/boltService.test.ts`, on the app's SDK): the real
  document-start script and the app's side of the bridge, two devices on a fake Arcade: mint and
  present, fungible pay and receive, tokens surviving a restart (SQLite), decline, a missing Arcade URL.
- **Headless in `packages/bolt`** (`test/webview.test.mjs`): the page script and the host service,
  prompt clamping, forged replies ignored, requests serialised.
- **On a device: not verified.** `packages/bolt/live/bsv-page.live.mjs` is written (the relay page
  in the app, funding, prompts read from the screen and answered by tapping, a verifier and a
  recipient outside the app) but has not passed. The one attempt (2026-10-06) opened the page in
  the app and then got no reply to `window.BOLT.getKey()`; the Metro log was still the previous
  session's, so the app was most likely running the bundle from before this code existed. That
  run says nothing about the app code either way. To run it: `.\e2e.ps1 -NoTest -RestartMetro`,
  wait for it to finish (Metro restarted, app reopened), then `node live/bsv-page.live.mjs`.

### Open

- **iOS child frames** forward only wallet (`CWI`) messages, and the provider is installed in the
  top document only, so an embedded frame has no `window.BOLT`.
- **Backup.** The token database is not part of the app's wallet backup.
- **Trusted issuers** are not configured in the app: a page names the issuer it expects per call
  (`verify(pkg, { issuer })`, `receive(pkg, { issuer })`).

## Funding of fungible operations

A fungible token the wallet owns funds its own transfer, split or merge from the change output its
transaction carries (no `createAction`, so no wallet funding transaction and no Hodos service fee).
Only a received split *piece*, which carries no change, draws one fresh output from the wallet; its
remainder self-funds after (`selfFundable` in `fungible.js`; pinned by the tests that count
`createAction` calls).
