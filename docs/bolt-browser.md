# `window.BOLT` in the browser

The page-facing BOLT interface — `packages/bolt` — can run in a web page as `window.BOLT`, beside the
wallet's existing `window.CWI`. This doc covers the Hodos injection (shipped as a shim) and the design
it follows. The handler/library itself is documented by the code in `packages/bolt/src`.

## The two models

`page.js` is written for a **thin** page shim talking to a **trusted** handler on the browser's own
side (`pageClient` on the page, `dispatcher` + a BOLT-semantic approve prompt on the trusted side).
That is the clean model, and it fits **bsv-browser**, whose wallet toolbox already runs in JS on the
app side — the handler and the real "transfer token X to Y" prompt run trusted in the RN app, the
WebView page gets only `pageClient`.

**Hodos has no trusted JS runtime** (its wallet is Rust, its shell is C++), so it uses the **fat
page-side model (A)**: the whole handler — `packages/bolt` + `b017` + `@bsv/sdk` — is bundled and
injected into the page, where it drives the wallet over Hodos's existing `wallet_call` IPC rail, the
same bridge `window.CWI` rides. See `docs/interface-simplification.md` for how this sits against the
full BRC-100 surface.

### What model A does and does not give

- The private key never leaves the Rust wallet. Every funding (`createAction`) and signing
  (`createSignature`) call still goes through the wallet's own BRC-100 consent, unchanged.
- Consent is therefore at **BRC-100 granularity** (the wallet's "sign / pay" modals), **not** BOLT
  semantics. A page can call `window.BOLT.transfer(...)`; the user sees the wallet's generic payment/
  signature prompt, not "transfer token X to Y". A trusted, BOLT-semantic prompt needs model-B
  (bsv-browser), where the handler runs on the trusted side and `dispatcher`'s `approve` is honoured.

## How the shim is built

`packages/bolt/src/browser.js` exports `installBolt({ walletCall, arcadeUrl, trustedIssuers, target })`.
It builds a `BoltHandler` on a `brc100Core` whose wallet adapter calls
`window.__hodos_walletCall(method, '/'+method, args)` — the bridge Hodos already injects for the CWI
shim — and defines a frozen `window.BOLT` exposing the `PAGE_METHODS`.

`npm run bundle` (`scripts/bundle-shim.mjs`) bundles `browser.js` + `b017` + `@bsv/sdk` with esbuild
into one IIFE (`dist/bolt-shim.js`, ~420 KB; b017's 128-bit balance math needs a `Buffer` polyfill,
injected by `scripts/shim-inject.js`), then wraps it as a C++ header (`dist/BoltShimScript.h`).

**The header is split into separate ~16 KB string-literal parts joined at runtime** by
`BoltShimScript()`: MSVC caps one string literal at ~16,384 bytes (C2026), and the cap also applies to
the concatenated result of *adjacent* literals, so a single 420 KB literal — or adjacent chunks — will
not compile. `dist/` is a build artifact (gitignored); regenerate it with `npm run bundle` whenever the
handler, b017, or the bundler changes.

## Wiring in Hodos

Two edits in `cef-native/src/handlers/simple_render_process_handler.cpp`, mirroring the CWI shim:

- `#include "../../include/core/BoltShimScript.h"` beside the `CWIShimScript.h` include.
- In `OnContextCreated`, in the external-page branch (https main frame), right after the
  `CWI_SHIM_SCRIPT` injection: `frame->ExecuteJavaScript(BoltShimScript(), url, 0);`. The
  `__hodos_walletCall` bridge is injected just above, so `window.BOLT` inherits it under the same gate.

`cef-native/include/core/BoltShimScript.h` is the generated header, copied from
`packages/bolt/dist/BoltShimScript.h`. It is checked into the Hodos repo (not ChainBrowsers).

Config: `installBolt` reads `window.__BOLT_CONFIG__` (`arcadeUrl`, `trustedIssuers`) if the browser
sets it before injection, defaulting `arcadeUrl` to `http://localhost:8080`.

⚠️ **The injection gate is `https://` main frames only** (it shares the CWI gate), so an
`http://localhost` test page does **not** get `window.BOLT` auto-injected. To exercise the shim on a
localhost page, load `dist/bolt-shim.js` with a `<script>` tag and call `BoltShim.installBolt(...)`
yourself.

⚠️ **Broadcast is a direct page `fetch` to Arcade.** `brc100Core`'s `arcadeBroadcaster` runs in the
page, so every op that touches the network — `mint`, `transfer`, `pay`, `receive`, and `verify` (which
broadcasts the anchor) — fetches `arcadeUrl` from the page's origin. On a real https site that is
subject to the site's CSP `connect-src` and to Arcade's CORS headers (not confirmed), so it is likely
to be blocked. Only `getKey`, `list` and `present` avoid Arcade. **To make the money-moving methods
work from a real page, broadcast must be proxied through the wallet rail** — a Rust endpoint (or a
ride on an existing one), which model A was chosen to avoid. This is the main open gap.

## Status / verified

- `browser.js` + the 420 KB bundle: proven headless — `test/browser.test.mjs` runs the real IIFE in a
  `node:vm` page with a mock bridge: `window.BOLT` installs frozen with the page methods, `getKey()`
  drives the wallet over the bridge at `/getPublicKey`, `list()` works offline, a wallet error throws.
- `BoltShimScript.h`: compiled under MSVC (VS2022 14.44) — the 27-part header builds with no C2026.
- **Not yet done in-browser**: a full Hodos shell build + loading a page and calling `window.BOLT`. The
  two source edits follow the documented extension point and use a standard CEF API, but the end-to-end
  run on the emulator/desktop is unverified here.

## Known costs / risks

- **The network-touching methods are not usable from a real page yet** (see the broadcast warning
  above): without a wallet-side broadcast proxy, `window.BOLT` on an https site can do `getKey`,
  `list` and `present`, not `mint`/`transfer`/`pay`/`receive`/`verify`.
- **~420 KB injected into every qualifying https main frame** on `OnContextCreated` (parse cost per
  page load). A follow-up could inject a small loader and evaluate the bundle lazily on first
  `window.BOLT` use, or gate injection to opted-in origins.
- **Fungible funding is hybrid** (`selfFundable` in `fungible.js`): a token the wallet owns funds its
  own transfer/split from its change (free — no `createAction`, no Hodos service fee); only a received
  split *piece*, which carries no change, draws one fresh output from the wallet rail, after which its
  remainder self-funds again. Pinned by the `createAction`-counting tests in `test/fungible.test.mjs`.
- **`createSignature` with `hashToDirectlySign` from an external domain**: the handler signs token
  covenant digests through this call. Whether the wallet's domain gating admits it from a real external
  https origin (as opposed to a localhost test page) is unverified; if it is refused, token *signing*
  from a page fails. Confirm against a running wallet before relying on it.

## Hodos repo note

The C++ change touches `cef-native/**`, so per the Hodos workflow it needs a relay-round note naming
the file (`simple_render_process_handler.cpp`) and the new header, so the other platform rebuilds.
