---
name: b017-source
description: Where the BOLT token library (b017) lives and which branch the user pointed at for interface work
metadata:
  node_type: memory
  type: reference
  originSessionId: ba169c51-1d68-457c-b6ae-0cefe1a2e054
  modified: 2026-10-05T15:17:16.573Z
---

b017 (the BOLT token library, TypeScript, only dependency `@bsv/sdk`) is `BOLT-Association/b017`. On 2026-10-05 the user pointed at branch `auth-bolt-plus-zf` (https://github.com/BOLT-Association/b017/tree/auth-bolt-plus-zf) as the one to read, "notably authbolt", when asked what BOLT requires of the wallet<=>browser interface. It is not in the ChainBrowsers repo or its browser clones. A newer working copy also sits at `C:\Users\honoh\Code\priv-chain\b017` (remote `F1r3Hydr4nt/priv-chain`), next to the `sx` contract toolchain b017's build scripts expect.

The user asked for the whole repo to be read before drawing conclusions, and stopped a delegated exploration to say so (my interpretation: read primary sources like this directly). Findings are in `docs/interface-simplification.md`; see [[chainbrowsers-status]].
