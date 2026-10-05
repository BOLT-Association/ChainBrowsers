---
name: lessons-ui-e2e-work
description: "Lessons from building the cross-wallet browser e2e (2026-10-04): what misled me and what to do differently in UI-driven and shared-environment test work"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 92009c78-15fb-4307-9437-394afab1c91f
  modified: 2026-10-04T22:42:11.985Z
---

These are my own lessons from the 2026-10-04 cross-wallet session, not rules the user stated, except where marked.

- **A step that passes in a visible UI may have passed because the user clicked.** Hodos raised a payment modal on every page `createAction`; my runs "passed" because the user was approving them by hand. The user then said (their words): "We need to automate the hodos modal acceptances for this test". Before calling a UI run unattended, check the product's own log for prompts (Hodos: `minted approval` / `X-User-Approved consumed`) and report who answered them.
- **Headless wallet tests do not exercise the app's monitor loop.** bsv-browser's proof path was broken on regtest in the real app while 19 live headless tests passed, because those tests run the proof task by hand. Do not call a mode verified until the real app has done the flow.
- **Check what is already installed before installing onto an emulator or device.** `bsv_pixel` had the user's app; a debug install could have wiped its data. Make a separate AVD.
- **Do not put a scripted edit and the command that depends on it on separate lines.** A Python edit failed its assertion and the next line still started a full test run. Use the Edit tool for edits, and chain dependent commands with `&&`.
- **Another Claude session may share the clone and the chain stack.** Its whole-directory jest run executed my new live test against my wallet mid-run. Gate a test that needs an external process behind its own flag, announce live runs to the peer first, never stage its files, and treat a result from an overlapping run as contaminated.
- **Windows specifics that cost time:** a DPI-unaware screenshot captures only part of a scaled screen (call `SetProcessDPIAware`); `SetForegroundWindow` from a background process does not raise a window (use `SetWindowPos` topmost then not-topmost); an Android native build can fail on the 260-character path limit with a misleading ninja "still dirty" error.

**Why:** each of these produced a wrong or misleading intermediate result that I reported or nearly reported.
**How to apply:** in e2e or demo work that drives real apps, on a shared machine. See [[cross-wallet-e2e-status]], [[working-rules-chainbrowsers]].
