---
name: e2e-real-browsers-side-by-side
description: "Cross-wallet e2e must show the real Hodos browser window and the Android emulator side by side, both in spv mode on Arcade"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 92009c78-15fb-4307-9437-394afab1c91f
  modified: 2026-10-04T20:16:24.672Z
---

For the Hodos / bsv-browser cross-wallet test, the user wants to **see the real Hodos browser and the Android emulator side by side interacting**, with both wallets explicitly in spv mode against the local Arcade. A plan that drove Hodos as a headless wallet process was rejected (2026-10-04): "Both browsers should be using spv mode and arcade, is this not explicit? We want to see the HODOS browser and the Android emulator side by side interacting with each other".

**Why:** the point is a visible demonstration of the two browsers transacting, not only protocol interop between wallet cores.

**How to apply:** headless checks are acceptable as a preliminary step (the user agreed to "1 then 2"), but the deliverable is the visible two-browser run. State the chain mode and Arcade endpoints explicitly in plans and docs. My interpretation: this applies to e2e/demo work in this repo, not to unit or live tests of a single wallet. See [[chainbrowsers-status]], [[bsv-browser-spv]].
