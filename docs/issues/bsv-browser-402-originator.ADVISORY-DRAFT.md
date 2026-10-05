# DRAFT — private security advisory (do not post publicly)

This is a draft for **private** disclosure to the bsv-browser maintainers. Do not open a public issue
or paste a working exploit anywhere until the maintainers have a fix out and agree to disclose.

**Channel (confirmed 2026-10-05).** Report through GitHub private vulnerability reporting, which is
enabled on the upstream repo:

> https://github.com/bsv-blockchain/bsv-browser/security/advisories/new

The fork `BOLT-Association/bsv-browser` is a fork of `bsv-blockchain/bsv-browser`, and the vulnerable
code is in the upstream, so the report goes upstream. There is no `SECURITY.md` or published security
contact on the fork, the upstream, or the `bsv-blockchain/.github` org repo, so the GitHub private
advisory form is the right channel (not an email, not a public issue). If you also want BOLT's own
maintainers to know (the fork ships it too), tell them privately in parallel.

---

**Title:** A web page can make the wallet pay as another site (HTTP 402 handler trusts page-supplied origin, amount and payee)

**Severity:** High (CVSS 3.1 7.4, `AV:N/AC:L/PR:N/UI:R/S:C/C:N/I:H/A:N`)

**Affected:** the in-app HTTP 402 payment path in `bsv-blockchain/bsv-browser` (`master`). The same code
is on the `BOLT-Association` fork (`master`, `spv-hardening`). Confirmed present upstream at
`app/index.tsx:1322/1332/1377` and `utils/webview/bsvPaymentHandler.ts:153/162`, with the handler given
the unguarded `managers.walletManager` at `app/index.tsx:789`; present since at least the 2026-07-22 402
commit (`1f6f446`). Please confirm which released builds ship it.

**Summary**

When a page's `fetch` receives an HTTP 402, injected script posts a `PAYMENT_REQUIRED` message to the
app and the app makes a BSV payment. The app trusts the URL, the amount and the payee key carried in
that message, all of which the page controls, and it derives the *paying site* (the spending
originator) from the page-supplied URL. Because any page script can post that message, a page on one
site can cause the wallet to spend as a different site — for an amount and to a key the page chooses —
without the named site ever requesting payment.

**Why it matters**

- The spend is attributed to, and charged against, a site the user did not transact with: that site's
  spending authorization, or the global auto-approve budget, can be drained with no prompt; above those
  limits the user sees a spending prompt that names a *trusted* site for an attacker-chosen amount.
- Money leaves the wallet without the user's intent and cannot be clawed back.
- If the named site has an open redirect, the attacker can also collect the funds; otherwise the funds
  are typically lost rather than stolen. Either way the user's loss is real.
- The paid response from the page-named URL is written into the current page's document.

**Where (for maintainers)**

- `app/index.tsx` handles `PAYMENT_REQUIRED` before the frame-origin check (payment branch vs. the
  origin check later in the same handler).
- `utils/webview/bsvPaymentHandler.ts` reads the amount and payee from the supplied headers and sets
  the originator to `new URL(url).hostname`; it applies no amount cap.
- `utils/webview/injectedPolyfills.ts` is the legitimate sender; any page script can post the same
  message.

**Verification**

A contained proof-of-concept drives the real `BsvPaymentHandler` with a stub wallet (no network, no
broadcast, no funds) and shows the handler attributing every wallet call to the page-named host,
applying no cap, and binding the output to the page-supplied key. It can be shared privately with the
maintainers on request. (It does not move funds and is deliberately not included here.)

**Delivery and what limits it**

- Preconditions: the victim is using bsv-browser with an unlocked, funded wallet, and opens
  attacker-controlled content in the **active** tab (a link, an ad or iframe, a compromised page). One
  `postMessage` then triggers it. Classic web delivery; no MITM and no native access needed.
- The attacker supplies the amount and payee headers directly, so no 402 server has to exist, and the
  named victim URL does not have to cooperate for the *spend* to happen.
- Only the active tab is honoured (background tabs are ignored) — a minor limiter, not a control.
- Whether the attacker **collects** the funds is the one hard part: the output is spendable only with a
  nonce the wallet sends solely to the page-named URL. Direct theft therefore needs the named site to
  forward that request to the attacker (an open redirect, or a site the attacker controls — but
  controlling it defeats the point of naming someone else). Without that, the result is a forced,
  misattributed, irreversible **loss**, not a transfer to the attacker.

**Where it can be intercepted / detected**

- The app already resolves the frame origin (`resolveWalletFrameIdentity`) but checks it *after* the
  payment branch. Moving that check before the branch is the interception point (see the fix).
- The wallet's spending-authorization layer is the backstop: amounts above the auto-approve threshold
  (default 100,000 sat) or the rolling 24h cap (1,000,000 sat) raise a prompt. The prompt names the
  **spoofed** site, so it misleads rather than warns; a careful user who does not recognise the named
  site as one they just paid can still decline.
- After the fact: the wallet's own history shows payments attributed to origins the user never
  transacted with — a detection signal for the user and for any monitoring.
- User mitigations until a fix: keep the wallet locked when not in use, set the auto-approve threshold
  to 0, and do not hold a large hot balance.

**Suggested fix**

1. Do not take the amount or payee key from the page; read them from a real 402 response the app
   fetches itself.
2. Run the frame-origin check before the payment branch, and decide deliberately which site is charged
   — the frame that initiated the request, not whatever host a page names.
3. Apply an amount ceiling in the handler.
4. Route the handler through the same guarded wallet wrapper that page calls use, not the raw manager.

**Reporter:** (your name / contact)

---

See also: a separate availability issue in the same app (grouped permissions enabled with no handler
bound can hang a site's own spending / `waitForAuthentication` calls), described in
`docs/interface-simplification.md`. Worth folding into the same private report.
