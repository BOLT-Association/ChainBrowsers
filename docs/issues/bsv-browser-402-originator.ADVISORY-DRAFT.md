# DRAFT — private security advisory (do not post publicly)

This is a draft for **private** disclosure to the bsv-browser maintainers. Do not open a public issue
or paste a working exploit anywhere until the maintainers have a fix out and agree to disclose. Send it
through a private channel — a GitHub **Security Advisory** on the upstream repo (Security → Report a
vulnerability), or the security contact in the repo's `SECURITY.md` / `security.txt` if one exists.
Confirm the exact upstream repo and contact before sending; this fork is `BOLT-Association/bsv-browser`.

---

**Title:** A web page can make the wallet pay as another site (HTTP 402 handler trusts page-supplied origin, amount and payee)

**Severity:** High (CVSS 3.1 7.4, `AV:N/AC:L/PR:N/UI:R/S:C/C:N/I:H/A:N`)

**Affected:** the in-app HTTP 402 payment path. Present on the fork's `master` and `spv-hardening`; the
handler file was last changed 2026-09-23. Please confirm which released builds ship it.

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
