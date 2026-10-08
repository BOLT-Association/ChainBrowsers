# Registration gated on an AuthBOLT

Status: built and verified live in Hodos on 2026-10-07 (see "What was built" at the end). It
describes how a site requires proof of ownership of an AuthBOLT before it accepts a registration (a
username, with an optional email, X or LinkedIn account), and what each part does.

## The model

AuthBOLT targets BRC-100 identity.

- **Users are the issuers; apps are the verifiers.** A user mints their own AuthBOLTs. There is no
  trusted-issuer list: an app learns a user's issuer key at registration and recognises it afterwards.
- **Every new token uses a new key.** A user may keep a default token or mint one per site. Separate
  keys keep tokens on different sites unlinkable unless the user links them, on or off chain.
- **AuthBOLTs only move to self.** The user can rotate the holder pubKeyHash with a self-transfer;
  the recorded issuerPubKey never changes. That constant key is the account's identity at the app.
- **Sites list; users mint and present.** A site may list only the token(s) tagged for it by its
  appPubKey. It may not mint or present. Both happen in the wallet's own UI, under the user's control.

## Can a server detect the wallet?

No. Neither Hodos nor BSV Browser adds a request header, a user-agent marker or a handshake that a
site's server could start. Detection happens in the page, and the page tells the server.

- **The page can see the wallet.** Hodos injects `window.CWI` and `window.BOLT` only into the main
  frame of external `https://` pages (`cef-native/src/handlers/simple_render_process_handler.cpp`).
  BSV Browser injects `window.CWI` but refuses wallet access to pages served from an IP address.
  `typeof window.BOLT !== 'undefined'` is the presence test.
- **HTTP 402 is the only thing a server can trigger.** Both browsers pay a 402 response natively
  (BRC-121). That is a payment, not a presence check, and in BSV Browser it is the path described in
  `docs/issues/bsv-browser-402-originator.md`. Do not build on it.
- **BRC-104 mutual auth runs from the page.** For an external server the handshake is page
  JavaScript calling the wallet. It is also how the wallet can learn that a site really holds the
  appPubKey it names (below).
- **BSV Browser has no `window.BOLT` in a shipped build.** It exists only on the fork's `window-bolt`
  branch and has not run on a device.

## Registration flow

An AuthBOLT presentation is an unfunded commit and settle that is never broadcast and carries up to
75 bytes of data. The app's server issues a challenge, the hash of the exact registration goes into
that data, and the user, not the site, decides which token answers it.

1. **Detect.** On load the page checks for `window.BOLT`. If it is missing, show "open in Hodos" and
   keep the form disabled.
2. **Look for an existing token.** The page calls `BOLT.list()`. The wallet returns only tokens
   tagged with this app's appPubKey: none for a new user, the linked token for a returning one.
3. **Fill the form.** Username, and optionally email, X handle, LinkedIn profile.
4. **Get a challenge.** The page posts the form to the server. The server stores a pending
   registration and returns a nonce and an expiry.
5. **Bind.** Both sides compute SHA-256 over a canonical statement: the app's domain, the
   appPubKey, the nonce, the expiry and the form fields. 32 bytes, under the 75-byte limit.
6. **Ask the user.** The page asks the wallet for a presentation of the hash to the appPubKey. The
   page cannot present: the request only opens the wallet's own prompt, which offers
   - the token already tagged for this app, when there is one;
   - otherwise "create an identity for this site", which mints a token under a new key and tags it
     with the appPubKey (a funded mint: a 1-sat token output plus the miner fee; the funding comes
     back as change);
   - behind a switch, the user's other tokens, each showing which sites it is already linked to.

   On approval the wallet presents the chosen token as a self-transfer: the settle pays the holder's
   own key, and the commit carries the auth data (the appPubKey and the challenge hash), which the
   settle covers. It returns only the package. Because the data names the app and the challenge, the
   package cannot be replayed to another verifier, and the token is never handed to the app.
7. **Verify on the server.** Never trust a verdict from the page. The server reads the issuer key
   from the package and runs b017's `verifyAndBroadcast` with that key as the trusted issuer, Arcade
   as broadcaster and Arcade's headers as the chain tracker. Accept only if:
   - the result is a presentation of an AuthBOLT;
   - the data equals the server's hash;
   - the data names this app's appPubKey;
   - the settle pays the same key the commit spent from (a self-transfer);
   - the nonce is unused and not expired;
   - the issuerPubKey is not already registered to another account.
8. **Register.** Record the issuerPubKey as the account's identity. Mark the nonce used.

**Signing in later** is the same challenge without the form: the server accepts a presentation whose
issuer key equals the recorded one, whatever holder pubKeyHash it carries now.

The optional links need their own proof: an email link, and OAuth or a posted code for X and
LinkedIn. Hashing them into the statement shows only that the token holder chose those values.

```
page                        wallet (user)                    server                  Arcade
 | window.BOLT present?        |                                |                       |
 | BOLT.list() --------------> | tokens tagged for this app     |                       |
 | POST /register (form) ---------------------------------------> pending, nonce        |
 | <---------------------------------------------- nonce, expiry |                       |
 | hash = H(domain|appPubKey|nonce|expiry|form)                  |                       |
 | request presentation -----> | prompt: use / create / switch  |                       |
 |                             | present(token, hash, to app)   |                       |
 | <--------------- package -- |                                |                       |
 | POST /register/proof -----------------------------------------> verifyAndBroadcast --> anchor seen
 |                                                              | issuer, data, owner,  |
 |                                                              | nonce; record issuer  |
 | <---------------------------------------------------- account |                       |
```

## Costs

| Action | Network cost |
|---|---|
| Mint a token | one funded transaction: a 1-sat output plus the miner fee |
| Rotate the holder key (self-transfer) | a funded commit and settle, both broadcast |
| Present | none; nothing is broadcast |

## What Hodos had to change (done, see the end)

Before this work `packages/bolt` and the Hodos rails did not match this model:

- **A new key per token.** `BoltHandler` signs every mint, transfer and presentation with one fixed
  key (`keyId = '1'`), so every token shares an issuer and holder key. Derive each token's issuer key
  separately, for example BRC-42 with the appPubKey as counterparty, so the mnemonic can re-derive it.
- **Scope the list to the app.** `BOLT.list` and `/boltTokens` return every token to any approved
  site, without a prompt. They must return only tokens tagged with the caller's appPubKey.
- **Prove the appPubKey.** A page could claim another app's appPubKey to see its tokens. The wallet
  should accept the tag only once the site has proved it holds the key (BRC-104), or bind it to the
  requesting domain, which Hodos stamps natively.
- **Remove mint and present from the page.** Both are page methods today. Replace them with the
  request in step 6, served by a native wallet prompt. That moves the handler to the trusted side
  (the BSV Browser model). In Hodos today it runs in the page and asks the wallet for raw signatures,
  which is why the prompt reads "use a protocol: bolt token" rather than what is being done.
- **Back up the tokens.** They are in the wallet database (V28 `bolt_tokens`), and a copy of the
  database file includes them, but the encrypted backup, the on-chain backup and the JSON export skip
  that table. A mnemonic recovery would restore the keys but not the tokens, whose transaction data
  cannot be rebuilt; with per-site identities that loses every account.

## Remaining gaps

- **An old holder key can still present.** Verification checks that the token's anchor was seen by
  the network, not that it is unspent (Arcade has no outspend endpoint). Under self-transfer every old
  holder key is the user's own, so this matters only if one of those keys leaks. From code reading,
  not tested.
- **Linking tokens is out of scope here.** An app sees only its own token. Whether a site may ask a
  user to prove a link between tokens, and how, is not designed.

## Implementation plan (decided 2026-10-07)

Decisions: the server check is a Node sidecar wrapping b017's verifier; AuthBOLT replaces passwords
in PeerLoop; "liveness" covers the token still being current, sessions kept alive by fresh
presentations, and presence tied to the token identity; Hodos gets the full model first.

**The data a presentation carries** (66 bytes; priv-chain `PLAN_peerloop.md` P2 extended):

| Bytes | Field |
|---|---|
| 1 | tag: `0x01` register, `0x02` sign in, `0x03` keep a session alive |
| 33 | the app's public key |
| 32 | SHA-256 of the server's challenge statement (purpose, origin, nonce, expiry, form) |

The server returns these 66 bytes; the page passes them to the wallet; the wallet reads the tag and
the app key to word its prompt and refuses data whose app key is not the one asked for.

**Who does what**

```
PeerLoop page ──/bolt/request──> Hodos C++ ──overlay──> trusted prompt (React + packages/bolt)
     ▲                              │                     │ wallet calls as Hodos itself
     └──────── package ─────────────┘ <── bolt_result ────┘
PeerLoop page ──package──> p2pd (b017-native, in process) ──> Arcade (anchor seen?)
                               │ roots judged by its own verified chain
p2pd header chain <── candidate headers ── Arcade chaintracks (+ tip stream)
```

**Chain trust.** Neither side trusts a server's word about the chain. Hodos runs in spv mode: it
takes headers from Arcade's chaintracks and keeps only what passes its own checks. PeerLoop does the
same in p2pd (plan item t38): a verified header chain with the Hodos rules (layout, proof of work,
regtest's fixed difficulty, pinned genesis, linkage, 2 h future limit, most work wins, reorgs),
synced from chaintracks and woken by its tip stream. p2pd judges merkle roots against that chain;
it never asks Arcade about them.

**The verifier (2026-10-09).** p2pd checks presentations in process on the Go port of b017
(`BOLT-Association/b017-native`, `go/authbolt`), which replaced the bolt-verify sidecar as the
default. The sidecar stays available with `-bolt-verify-url` (it then asks p2pd about roots on a
loopback port). Real presentations and the sidecar's answers to them are recorded into
`p2p/testdata/contract/verify/recorded.json` by `packages/bolt/scripts/record-verify-contract.mjs`,
and p2p's tests hold the Go verifier to every recorded verdict and reason. The Go verifier does not
know auth-data tag 04 (a write) yet.

- **packages/bolt:** an identity module: the data format; a key per AuthBOLT (its own BRC-43
  protocol, keyID kept with the token); app tags and keep-signed-in grants in the token's
  attributes; presenting for an app after checking the data names that app. A sidecar server
  (`bolt-verify`) for relying parties. `mint` and `present` leave the page interface.
- **Hodos Rust:** `/boltTokens` shows an external site only the AuthBOLTs tagged for it and refuses
  its writes to AuthBOLT rows; the identity protocol is refused to external sites; `bolt_tokens`
  joins the backups.
- **Hodos C++:** `/bolt/request` from a page opens the prompt and answers the page when the prompt
  sends `bolt_result`; a keep-alive request goes to the preloaded overlay without showing it.
- **Hodos frontend:** the prompt (use this site's identity, create one, or switch), a vendored
  bundle of the identity module, and an Identities list in the wallet panel.
- **p2pd:** challenges and register / sign-in / refresh routes calling the sidecar; accounts keyed
  by the issuer key; no passwords; short sessions refreshed by presentations; the identity shown
  on a person's profile. The lab uses a stand-in verifier and a stand-in `window.BOLT`, since its
  browsers have no wallet; the real path is tested with Hodos on the regtest stack.

## What was built (2026-10-07)

Verified live: `node tests/authbolt/peerloop.live.mjs` registers, signs in, keeps a session alive
and signs in again on PeerLoop in the real Hodos browser (spv mode on the regtest stack), clicking
Hodos's own prompt through DevTools. With `NC_NO_VERIFIER=1` it fails at registration, as it must.
Screenshots and logs: `tests/cross-wallet/out/authbolt/`.

| Where | What |
|---|---|
| `packages/bolt/src/identity.js` | The auth data format; `IdentityWallet` (a key per identity under the BRC-43 protocol `authbolt identity`, app links and keep-signed-in grants in `attributes.wallet`, present only with data naming the asking app, silent refresh only with a grant, `rotate` to a new holder key); `verifyIdentity` for a relying party |
| `packages/bolt/src/verify-server.js`, `bin/bolt-verify.mjs` | The sidecar: `POST /verify` with a shared secret; roots asked of the app server's own header chain (`HEADERS_URL`), never of Arcade |
| `packages/bolt/src/identity-service.js` | What Hodos's prompt runs, bundled to `frontend/src/vendor/bolt-identity.js` (`npm run bundle:identity`) |
| `packages/bolt/src/page.js`, `browser.js` | A page cannot mint or present an AuthBOLT; `requestPresentation` goes to `POST /bolt/request` |
| Hodos `rust-wallet` | `/boltTokens` shows a site only the identities linked to it and refuses its identity writes; `op: annotate` from Hodos's UI only; the identity protocol is refused to every site (`permission_service/identity_guard.rs`); `bolt_tokens` is in the backups |
| Hodos `cef-native` | `/bolt/request` is checked (`BoltRequest.h`), held, and answered by the prompt's `bolt_result` (approval overlay only, `IpcAuth.h`) or a 5-minute timeout; a keep-alive goes to the preloaded overlay's `window.boltSilent` without showing it |
| Hodos `frontend` | `BoltIdentityPrompt.tsx`: this site's identity, a new one, or another (with the sites each is linked to), and "keep me signed in"; the identity code loads only when a request needs it |
| p2p | No passwords. `internal/authbolt` (challenges, auth data, the sidecar client), routes `/api/auth/challenge`, `register`, `signin`, `refresh`; accounts keyed by the issuer key with optional email, X and LinkedIn; 30-minute sessions renewed by keep-alives; `internal/headers`, its own verified header chain (Hodos's rules) synced from chaintracks and its tip stream, answering the sidecar on a loopback port |

Not built yet: an Identities list in the Hodos wallet panel (see, unlink, rotate, revoke
keep-signed-in), linking identities to each other, mainnet header rules (both chains are regtest
only), BSV Browser (set aside by the user).
