# AuthBOLT holder keys on chain (plan, 2026-10-10, not yet approved)

The V1 design (`authbolt-registration.md`, "After registration: holder-key signatures") keeps an
identity's holder key **off chain**. It replaces part of that with the model the user set out on
2026-10-10:

> "a registration necessarily requires the presentation of a mint along with an immediate rotation
> commit and settle (which should be broadcast and funded)"

The user's decisions (2026-10-10):

- **Registration is an on-chain rotation.** The issuer key spends the mint in a funded commit and
  settle, broadcast through Arcade, that moves the token to a new holder key.
- **The next key is covered by the issuer's signature.** The wallet and the backend keep
  **derivation counts** in step.
- **Later rotations are on chain too:** another commit and settle, by the current holder.
- **Recovery stays an issuer-signed rebind** (off chain, as in V1).

## Today (V1) and what changes

| | V1 (built) | This plan |
|---|---|---|
| **Registration package** | mint + commit + settle back to the issuer key. The commit and settle are unfunded, so they can never be broadcast (`nft.js`: "an unfunded commit pays out one more sat than it takes in"). | mint + commit + settle to holder key *n*, both funded and **broadcast before presenting** |
| **What Arcade is asked** | only whether the mint was seen | whether the mint, commit and settle were seen |
| **Holder key at registration** | the issuer key; the first sign-in rotates off chain, silently (`moveOffIssuerKey`) | holder *n*, already on chain; no rotation at first sign-in |
| **Later rotations** | holder-signed rebind, `POST /api/auth/rotate`, `seq` in p2pd's `identities` table | a funded commit and settle by the current holder; p2pd follows the token |
| **Recovery** | issuer-signed rebind (`POST /api/auth/recover`) | unchanged (see open question Q3) |
| **Re-registering after a server wipe** | the same token could present again (until V1's mint rule) | impossible: the mint is spent. A new identity, as fred did on 2026-10-10 |

## How the next key is fixed: the recommendation

**Holder key *n* is an ordinary wallet key**, derived as BRC-43 does for every key the wallet
holds:

- protocol `[2, 'authbolt identity']`;
- keyID `<the identity's issuer keyID>.holder.<n>`;
- counterparty `self`.

**The issuer key signs over it twice:**

1. The commit, which the issuer key signs, fixes its destination `toPkh = hash160(holder n)` in
   the commit's own output (`buildCommit`). The covenant makes the settle pay exactly that key.
2. The auth data the commit carries names *n*.

**The server learns the public key with the first signature.** It records `hash160(holder n)` and
*n* at registration. Holder signatures already carry the holder public key (`BOLT.sign` returns
`holder`). On the first one, p2pd checks that `hash160(holder) == the recorded hash` and then
stores the key.

**Why not the other two options discussed:**

- **Counterparty = the app's key** (the app could compute holder *n* itself): p2pd would need the
  app's **private** key. Today it holds only the public one (`-app-key`), and holding a secret is
  against boltverifyd's and p2pd's "no secrets" design.
- **Counterparty = "anyone"** (anyone could compute holder *n*): in a BRC-100 wallet, derivation
  starts from the wallet's master key, not from the identity's issuer key. Every holder key would
  then be computable from the person's master identity key, which links all their per-site
  identities, the very thing a key per identity exists to prevent. Deriving from the issuer key
  instead would need new derivation code in the Hodos Rust wallet (crypto code, which needs the
  owner's approval).
- **Holder key in the auth data:** it does not fit. b017 caps `authOrMiscData` at 75 bytes (one
  direct push, `AuthBolt.sx.template.ts`); today's data is 66 bytes, plus 33 for a key makes 99.

**What the counts are for:** they keep the wallet and the server in step. A wallet restored from its
seed can re-derive every holder key from the count alone. The server refuses a rotation whose
*n* is not the next count, so a replayed or out-of-order rotation is refused, as `seq` does today.

## The auth data (register)

| Bytes | Field |
|---|---|
| 1 | tag `01` (register) |
| 33 | app public key |
| 32 | challenge hash |
| 4 | holder count *n*, big-endian (new) |

70 bytes, within the 75-byte cap. The other purposes keep their 66 bytes. A rotation commit carries
a new tag (proposed: `05`) with the app key, *n*+1 and 32 zero bytes, so a rotation names the app
and the count it moves to.

## Flow

```
Registration
  wallet: mint (exists) ──commit (issuer signs: toPkh = h160(holder n), auth data names n)──┐
          funded, broadcast to Arcade                                                       │
          settle (pays holder n), funded, broadcast  <────────────────────────────────────┘
  page ──package [mint, commit, settle]──> p2pd ──> boltverifyd
          boltverifyd: commit spends the mint (V1 rule); commit and settle seen by Arcade;
                       settle owner = commit toPkh; verdict adds holderPkh, n, settle outpoint
  p2pd: records issuer, holderPkh, n, the token's outpoint (the settle's)

First sign-in
  wallet signs with holder n ──{identity, holder, signature}──> p2pd
  p2pd: h160(holder) == holderPkh? record holder; check the signature

Rotation (n -> n+1)
  wallet: commit (holder n signs, toPkh = h160(holder n+1), tag 05, n+1) + settle, funded, broadcast
  page ──[commit, settle]──> p2pd: spends the recorded outpoint? seen by Arcade? n+1 next?
  p2pd: new holderPkh, n+1, new outpoint; every session ends

Recovery (unchanged)
  issuer key signs a rebind to holder n+1 over a sign-in challenge ──> p2pd
```

## Open questions (to answer before building)

- **Q1. The verifier's anchor rule.** Is "the commit and settle were seen by Arcade" enough at
  registration, or must the settle be **mined** (proven into p2pd's headers) before the account is
  approved? Recommendation: seen is enough to register; first-seen settles conflicts.
- **Q2. Who learns about a rotation.** The page posts the commit and settle to p2pd (as above), or
  p2pd watches the token's outpoint through Arcade itself. Recommendation: the page posts them.
  Arcade has no outspend lookup, so p2pd could not watch by itself.
- **Q3. After a recovery, the token is stranded.** The recovery rebinds the account off chain, but
  the token still sits at the lost holder key, which nobody can move. Should later rotations then
  be off chain for that identity, or does recovery mean registering a new identity?
  Recommendation: after a recovery, rotations are off-chain rebinds by the recovered key (V1's
  path, kept for this case only).
- **Q4. Counted issuer keys.** Issuer keyIDs are random today (`authbolt-<16 random bytes>`), so a
  seed restore cannot find an identity without the token store (which is not in Hodos's backup).
  Should identities be counted too (`authbolt-<i>`), so a seed and two counts recover everything?
- **Q5. Keep-signed-in.** Rotations cost two transaction fees. Under the keep-signed-in grant, may
  the wallet rotate (and pay) silently, or always ask?

## Steps (red then green; the gates on every green commit)

1. **b017-native and packages/bolt:** the register auth data with *n* (70 bytes) and the rotation
   tag; contract vectors re-recorded.
2. **packages/bolt:** registration funds and broadcasts the commit and settle to holder *n*;
   counted holder keyIDs; on-chain `rotateHolder`; the off-chain rotate and confirm go (recover
   stays). Pretend-chain tests.
3. **boltverifyd and the Node sidecar:** the anchor rule (commit and settle seen) and the verdict
   fields; b017-native's `go/authbolt` the same.
4. **p2pd:** `identities` gains `holder_pkh`, `count` and `outpoint` (a migration); register
   records them; the first signature binds the key; `POST /api/auth/rotate` takes a commit and
   settle; the web client drops `moveOffIssuerKey`.
5. **Hodos:** the regenerated bundles; the prompt says that registering spends a small fee twice;
   `hodos_tests`, `tsc -b`.
6. **Live:** `tests/authbolt/peerloop.live.mjs` registers on chain, signs in, rotates on chain,
   recovers. Negative controls: an unbroadcast settle is refused at registration; a rotation with
   a skipped count is refused.
7. **Wipe the demo again** (after a backup) and re-register fred on the new flow.

## Related

- The held "most recently used identity" fix (the test is written, the code is not): with several
  identities linked to one app, the wallet's prompt and its silent path both use the **oldest**.
  This plan makes it more likely (every re-registration is a new identity), so it should land
  before step 7.
