---
name: test-artifacts-in-repo
description: "Save test screenshots and other run artifacts to a gitignored folder inside the repo, not the temp directory"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 92009c78-15fb-4307-9437-394afab1c91f
  modified: 2026-10-04T22:32:51.038Z
---

Save test screenshots (and other run artifacts I need to read back) to a gitignored folder inside the repo, e.g. `tests/cross-wallet/out/`, not `%TEMP%` or other external paths.

**Why:** reading files outside the working directory makes the user grant access to external files. The user asked (2026-10-04): "Can't we save test scrots to a gitignored folder in the repo so we don't have to give access to external files?"

**How to apply:** when a test or a debugging step produces screenshots or logs, write them under a gitignored directory in the repo being worked on (add the ignore entry if missing) and read them from there. My interpretation: this covers logs and other artifacts too, not only screenshots. See [[e2e-real-browsers-side-by-side]].
