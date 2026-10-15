---
name: bolt-interface-status
description: "State of the BOLT page interface work (packages/bolt, docs/interface-simplification.md) and the decisions the user made about it"
metadata:
  node_type: memory
  type: project
  originSessionId: ba169c51-1d68-457c-b6ae-0cefe1a2e054
  modified: 2026-10-05T15:49:14.350Z
---

Started 2026-10-05. Goal: a small BOLT interface for pages, beside BRC-100, in both browsers.

**Decisions by the user (2026-10-05):**
- AuthBOLT is meant to stand in for BRC-100's certificate and auth methods.
- The BOLT interface is added alongside the existing BRC-100 interface; BRC-100 stays.
- Arcade is the broadcaster and status source; no need to question that.

**Built:** `packages/bolt` (plain ESM JS, `node --test`): `BoltHandler` (getKey, list, verify, receive, present, transfer, mint) for MinSimpleBOLT and AuthBOLT, on b017 pinned at `9e2d8bf` ([[b017-source]]); `brc100Core` runs it on an unchanged BRC-100 wallet (getPublicKey, createSignature with hashToDirectlySign, getHeaderForHeight, createAction for a funding output) plus Arcade; `dispatcher`/`pageClient` for the page side. 9 headless tests pass; `live/hodos.live.mjs` passed twice on a Hodos wallet in spv mode.

**Not built:** `window.BOLT` injection in either browser (planned order: bsv-browser first, then Hodos), fungible SimpleMultiBOLT, a durable store, bsv-browser as the wallet in a live run.

**Things that are easy to get wrong:**
- b017 publishes only `dist/`, so a git dependency arrives unbuilt: `npm run vendor` builds and packs it into `packages/bolt/vendor/` (gitignored).
- b017 templates call `key.sign()` synchronously; `src/signer.js` builds each tx twice (record digests, replay wallet signatures). A commit must be fully signed before its settle is built (the settle spends the commit's txid).
- Both commit and settle are signed by the current owner; the recipient gives only a pubKeyHash.
- An unfunded commit creates value (1 sat in, 2 out) and can never be broadcast, so an unfunded pair is a presentation, not a transfer; a transfer needs a funded, broadcast pair so the next anchor is on the network.
- Live test scripts must not sit under `test/` (`node --test` would run them with the stack down).

Findings and the Hodos route trace are in `docs/interface-simplification.md`; the bsv-browser 402 issue is in `docs/issues/`. Nothing from this work was committed as of 2026-10-05. See [[chainbrowsers-status]].
