# bsv-browser: a page can make the wallet pay as another site (HTTP 402 handler)

Status: 2026-10-05. **Handler half reproduced** by a contained PoC (jest, stub wallet, no network, no funds): `poc/bsvPayment402Originator.poc.test.ts`. The dispatch-ordering half is from code reading. **Not reported upstream.**

## Reproduction

`docs/issues/poc/bsvPayment402Originator.poc.test.ts` runs the real `BsvPaymentHandler` with a stub wallet that records the originator it is called with. Drop it into `browsers/bsv-browser/__tests__/` and `npx jest __tests__/bsvPayment402Originator.poc.test.ts` (kept out of the shared fork clone's git on purpose). It passes, showing that for page-supplied `url` and headers the handler:

- attributes every wallet call to `new URL(url).hostname` (`victim.example`), never to the page that sent the message;
- applies no amount cap (999,999 sat passes straight through);
- binds the payment output to the page-supplied payee key (`counterparty` = `x-bsv-server`);
- sends the spend's nonce only to the page-named URL.

What the PoC does **not** show, and is left to the code trace: that a page can post `PAYMENT_REQUIRED` (the injected `fetch` at `injectedPolyfills.ts:792`, plus any script can `postMessage`), that the app handles it before the origin check (`app/index.tsx:1322` vs `:1377`), and whether a real spend completes with **no** user prompt — that depends on the permissions manager's spending-authorization and auto-approve, which the stub wallet replaced. So the PoC confirms the attribution-and-amount core; the unprompted-spend tier in the severity table rests on the toolbox read, not on this PoC.

| | |
|---|---|
| Component | bsv-browser app, the HTTP 402 payment path |
| Version read | app 1.6.3, branch `spv-hardening` at `917f0aa`. The same code is on the fork's `master` (`app/index.tsx:1322`). |
| Files | `app/index.tsx:1322-1345`, `utils/webview/bsvPaymentHandler.ts:131-208`, `utils/webview/injectedPolyfills.ts:786-803` |
| Severity | **High: CVSS 3.1 base 7.4** (`AV:N/AC:L/PR:N/UI:R/S:C/C:N/I:H/A:N`): a web page causes an irreversible spend the user did not intend. Calculation below. |

## Summary

When a page's `fetch` gets an HTTP 402, a script the app injects posts a `PAYMENT_REQUIRED` message to the app, and the app pays. The app trusts three things in that message that the page controls: the URL, the amount and the payee's key. It takes the paying site (the "originator") from the URL. A page can post the message by hand, so a page on one site can make the wallet pay as any other site, for an amount and to a key the page chooses, without that site ever having asked for a payment.

## How it works

1. The injected `fetch` wrapper posts `{ type: 'PAYMENT_REQUIRED', url, status, headers }` (`injectedPolyfills.ts:792-799`). Nothing stops page script, or a frame in the page, from posting the same message through `window.ReactNativeWebView.postMessage`.
2. The app handles it before it checks which frame sent it. The origin check is at `app/index.tsx:1377`; the payment branch is at 1322 and returns at 1344. The only filter is that the message came from the active tab (1229).
3. `handle402(msg.url, msg.status, msg.headers)` reads the amount and the payee key from the page-supplied headers (`bsvPaymentHandler.ts:132-133`). It asks the URL itself only when both are missing (137-143), so supplying them skips that request.
4. The originator is `new URL(url).hostname` (162). Every wallet call that follows uses it: two `getPublicKey` calls, `createAction`, `signAction` (168-226).
5. The transaction is created and broadcast before the URL is ever contacted (190-208, `acceptDelayedBroadcast: false`). The URL need not exist.
6. Only afterwards does the app request the URL, with the payment in headers: the sender's identity key, the transaction, and the nonce the payee needs to spend the output (237-250).

So a page on `evil.example` can post:

```json
{ "type": "PAYMENT_REQUIRED", "url": "https://shop.example/x", "status": 402,
  "headers": { "x-bsv-sats": "100000", "x-bsv-server": "<a key the page chose>" } }
```

and the wallet pays 100,000 satoshis as `shop.example`.

## What the wallet's spending controls do with it

The handler uses the wallet without the page-facing guard, but spending authorization still applies, for the spoofed originator:

| Case | What happens |
|---|---|
| The named site holds a spending authorization with allowance left | No prompt. The payment is taken from that site's allowance. (Read in the toolbox bundle on the first pass; not re-read here.) |
| Amount at or below the auto-approve threshold (default 100,000 sat) | No prompt (`WalletContext.tsx:1111-1124`). The 10 s cooldown is per originator (`autoApprovePolicy.ts`), so naming a different site each time avoids it. The global cap is 1,000,000 sat per 24 h (`constants.ts:17`). |
| Anything else | A spending prompt that names the spoofed site, for the amount the page chose. |

The handler has no amount limit of its own: `Number.parseInt(satsHeader)` (153).

## Impact

**Where the money goes.** The output pays a key derived from the page-supplied payee key and a nonce the wallet picks (8 random bytes, line 158). Whoever holds the payee's private key can spend it only with that nonce, and the nonce is sent only to the URL in the message. So:

- In the ordinary case the page cannot collect. The user's money is spent to an output nobody can spend: it is lost, not stolen.
- If the named site redirects the request to the attacker (an open redirect), the attacker receives the nonce and the transaction and can collect. The handler follows cross-origin redirects (259-262). Whether the payment headers survive the redirect in React Native's `fetch` was not checked.

**What an attacker gains over normal behaviour.** A site can already charge its own visitors up to the auto-approve limits without a prompt; that is the wallet's micropayment policy. The flaw adds:

1. Spending another site's allowance, which the user granted to that site and not to this page.
2. A spending prompt that carries a trusted site's name for an amount the attacker chose.
3. No per-site cooldown, so the daily auto-approve cap can be used up in one burst.
4. Wrong records: the wallet's history attributes the payments to a site that never asked for them.

**Also:** the HTML that comes back from the named URL is written into the current page (`app/index.tsx:1334-1337`), so content from one site is rendered in another site's document.

## Severity calculation

**High: CVSS 3.1 base 7.4** (`AV:N/AC:L/PR:N/UI:R/S:C/C:N/I:H/A:N`).

| Metric | Value | Why |
|---|---|---|
| Attack vector | Network | a web page the user opens |
| Attack complexity | Low | one `postMessage`; no race, no special state |
| Privileges required | None | any page, or any frame in the active tab |
| User interaction | Required | the user has to have the page open in the active tab |
| Scope | Changed | web content, which the browser confines to its own site, acts with the wallet's authority for a different site |
| Confidentiality | None | the identity key goes to the named site, which any site may already ask for |
| Integrity | High | the wallet spends the user's money without the user's intent, and the spend cannot be undone. For a wallet that is the most serious thing that can go wrong, whatever the amount |
| Availability | None | |

- Impact = 7.52 x (0.56 - 0.029) - 3.25 x (0.56 - 0.02)^15 = 3.99
- Exploitability = 8.22 x 0.85 x 0.77 x 0.85 x 0.62 = 2.84
- Base = round up (1.08 x (3.99 + 2.84)) = **7.4, High**

**An earlier version of this document scored it 4.3 (Medium).** That rated Integrity as Low because the amount that can be taken with no prompt is small at default settings, and Scope as Unchanged. Both were the wrong reading for a wallet. Money leaving without consent, irreversibly, is a serious integrity loss in itself; and two of the three paths are not bounded by the small cap at all. The cap describes how much, not how bad.

How much, by path:

| Path | Prompt | Bound |
|---|---|---|
| Auto-approve | none | 100,000 sat per payment, 1,000,000 sat (0.01 BSV) per 24 h across all sites, at default settings; the user can raise the threshold |
| The named site's existing allowance | none | whatever the user granted that site |
| Spending prompt naming the spoofed site | one tap, on a prompt that names a site the user trusts | the wallet's balance |

Whether the attacker also collects the money (the open-redirect case) does not change the score: the user's loss is the same either way.

For comparison, with Scope read as Unchanged the same vector scores 6.5.

## Fix direction

1. Do not take the amount or the payee key from the page. Have the app request the URL itself and read them from a real 402 response.
2. Run the origin check before the payment branch, and decide deliberately which site pays: the frame that made the request, or the host that answered 402. Today a cross-origin `fetch` is charged to the host that answered.
3. Put a ceiling on the amount in the handler.
4. Route the handler through the same guarded wallet that pages get.

## Not checked

- The handler path is now exercised by the PoC (stub wallet). The end-to-end spend on a device, and the spending-token / auto-approve behaviour inside the toolbox bundle, are still from reading, not a run.
- Whether a site normally ends up holding a persistent spending authorization in this app. The auto-approve grants are ephemeral (`WalletContext.tsx:1121`); a grant from the prompt was not traced.
- Whether payment headers survive a cross-origin redirect.
- How `createAction` treats a non-numeric or negative amount from `parseInt`.
- Whether upstream (`bsv-blockchain/bsv-browser`) has the same code; the fork's `master` does, and the handler file was last changed there on 2026-09-23.

## Related

A separate availability problem in the same app: grouped permissions are switched on with no handler bound, so a site whose manifest declares group permissions can hang its own spending and `waitForAuthentication` calls. See `docs/interface-simplification.md`.
