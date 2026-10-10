# AuthBOLT holder keys on chain (plan, 2026-10-10; all questions answered, not yet approved to build)

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
- **Recovery stays an issuer-signed rebind** (off chain, as in V1). Refined the same day (Q3): the
  lost holder's token is dead, so recovery reissues one.
- **The app pays for its users' transactions** from a wallet of its own (Q5).

## Today (V1) and what changes

| | V1 (built) | This plan |
|---|---|---|
| **Registration package** | mint + commit + settle back to the issuer key. The commit and settle are unfunded, so they can never be broadcast (`nft.js`: "an unfunded commit pays out one more sat than it takes in"). | mint + commit + settle to holder key *n*, both funded and **broadcast before presenting** |
| **What Arcade is asked** | only whether the mint was seen | whether the mint, commit and settle were seen |
| **Holder key at registration** | the issuer key; the first sign-in rotates off chain, silently (`moveOffIssuerKey`) | holder *n*, already on chain; no rotation at first sign-in |
| **Later rotations** | holder-signed rebind, `POST /api/auth/rotate`, `seq` in p2pd's `identities` table | a funded commit and settle by the current holder; p2pd follows the token |
| **Recovery** | issuer-signed rebind (`POST /api/auth/recover`) | **reissuance**: the issuer key mints a new token and moves it to the next holder; the old token is dead (Q3) |
| **Fees** | the person's wallet | the app's own funding wallet, with signed inputs (Q5) |
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

Recovery (reissuance; the token at the lost holder key is dead)
  wallet: new mint by the SAME issuer key (so the identity, its issuerPubKey, stays)
          + commit (issuer signs: toPkh = h160(holder n+1), tag 06, n+1) + settle, all broadcast
  page ──[mint, commit, settle] answering a sign-in challenge──> p2pd ──> boltverifyd
  p2pd: same issuer as a recorded identity? new outpoint, holderPkh, n+1; every session ends
```

## Answers (user, 2026-10-10)

- **Q1. The anchor rule: seen by Arcade is enough.** "Seen by is enough it means it's going to be
  mined." The mint, commit and settle must each be seen by Arcade; nobody waits for a block.
- **Q2. A rotation is posted by the page.** Yes: the page sends the commit and settle to p2pd
  (Arcade has no lookup for what spent an output, so p2pd could not watch for it).
- **Q3. After a recovery: "Token is dead needs reissuance".** A token whose holder key is lost can
  never move again. Recovery therefore mints a **new** token with the identity's **same issuer
  key**, so the identity (its `issuerPubKey`) and the account stay, and moves it at once to holder
  *n*+1. p2pd replaces the recorded outpoint. That replaces V1's off-chain rebind
  (`POST /api/auth/recover` takes the new package instead of a signed rebind). The issuer key
  stays the one thing to keep safe. Proposed tag for its commit: `06`.
- **Q4. Counted issuer keys: "Why not?"** No reason against: a keyID with counterparty `self` can
  only be derived with the wallet's master private key, so counting reveals nothing to anyone else.
  Identity *i* uses keyID `authbolt-<i>`, holder *n* uses `authbolt-<i>.holder.<n>`, and the
  wallet keeps the next *i*. Existing identities keep their random keyIDs (they are stored). A seed
  restore can then re-derive every identity key (`authbolt-0, 1, 2…`) and every holder key from
  its count. It cannot find the tokens themselves from Arcade, which has no lookup by key or
  address: the outpoints must come from the app's records (Q7) or an indexer.
- **Q5. Silent rotation under the grant: yes.** In the user's words: "we are going to make the p2p
  app have it's own wallet for funding user transactions, it will send signed inputs with
  sighashSingle". The person's wallet does not pay: p2pd's own wallet signs a funding input with
  `SIGHASH_SINGLE | ANYONECANPAY | FORKID`, the page hands it to the person's wallet, and the
  wallet adds it to the commit and settle and signs the token input. Rotating silently therefore
  costs the person nothing.

## App-funded transactions: what b017 allows

b017's covenant fixes the layout (`singleSpend.ts`): inputs `[token, proof?, funding?]`, outputs
`[token, proof output?, change?]`. That allows one funding input, with change optional and
returned to whoever funded it. `SIGHASH_SINGLE` signs only the output at the same index as the
signed input:

| Transaction | Funding input | Output at that index | What the app's signature covers |
|---|---|---|---|
| commit | 1 | the proof output (1 sat to the new holder) | not the app's change: the person could redirect it |
| settle from the mint | 1 | the change | the app's change |
| settle after a commit with a proof input | 2 | none | no output at all |

Recommendation: the app funds each transaction with a **coin of exactly the fee** and takes **no
change**. Then whatever `SIGHASH_SINGLE` covers, the app cannot lose more than that fee, and the
person cannot divert anything. The app's wallet keeps a stock of fee-sized coins (split ahead of
time). The alternative, `SIGHASH_ALL | ANYONECANPAY` with change, would make the app build the
whole output list itself.

Two more answers (user, 2026-10-10):

- **Q6. Abuse: limited by who asks.** "Registration is by invite only and happens only once,
  rotations are requested by the app not the user." So:
  - the app hands out a funding coin for a registration only against a valid, unused invite, once
    per invite;
  - a rotation starts with the **app**: p2pd decides when an identity rotates and sends the page
    a rotation request carrying the funding input; the wallet rotates silently under the grant.
    A page cannot ask for a rotation (or a fee coin) by itself.
  - This conflicts with p2pd's `-open-signup` (added at the user's request the same morning, the
    demo runs with it): with invite-only registration, open sign-up would apply only to approving
    an invited registration at once. To confirm when step 4 starts.
- **Q7. No: "it's a separate wallet".** p2pd keeps no lookup for restored wallets; a person's
  wallet restores its identities from its own records and backups. And the app's funding wallet
  is a **separate wallet**, not part of p2pd (my reading of the same answer): p2pd asks it for a
  signed input, and its key never enters p2pd (which keeps no secrets).

## Steps (red then green; the gates on every green commit)

1. **b017-native and packages/bolt:** the register auth data with *n* (70 bytes) and the rotation
   tag; contract vectors re-recorded.
2. **packages/bolt:** registration broadcasts the commit and settle to holder *n*, funded by the
   app's signed input; counted identity and holder keyIDs (Q4); on-chain `rotateHolder`; recovery
   by reissuance (Q3); the off-chain rotate, confirm and rebind go. Pretend-chain tests.
3. **boltverifyd and the Node sidecar:** the anchor rule (commit and settle seen) and the verdict
   fields; b017-native's `go/authbolt` the same.
4. **p2pd:** `identities` gains `holder_pkh`, `count` and `outpoint` (a migration); register
   records them; the first signature binds the key; `POST /api/auth/rotate` takes a commit and
   settle; `POST /api/auth/recover` takes a reissued package; the web client drops
   `moveOffIssuerKey`.
4b. **The app's funding wallet (a separate service):** its own key, a stock of fee-sized coins,
   and a loopback endpoint p2pd calls for a signed `SIGHASH_SINGLE | ANYONECANPAY` input: for a
   registration with a valid unused invite, or for a rotation p2pd itself requested (Q6). It goes
   through Arcade like everything else. p2pd: invite-only registration; the rotation request it
   sends the page.
5. **Hodos:** the regenerated bundles; the wallet accepts an app's signed funding input (it signs only
   its own token input) and shows who pays;
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
