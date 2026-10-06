# Hodos spv mode: an Arcade outage makes the wallet fail its own mined transactions

Found 2026-10-06 on `arcade-provider` (`3c35cc33`) with a regtest test wallet. **Not fixed.** It is a
change to money-path logic, so it needs the owner's go-ahead (Hodos invariant 13).

## What happens

1. The wallet has transactions it broadcast that are mined but for which it has not stored a proof yet
   (here: `createAction` funding transactions; the wallet had been stopped seconds after making them).
2. The wallet starts while Arcade is unreachable (Docker was not running), more than the proof
   task's timeout after those transactions (here 18 h 54 m).
3. `monitor/task_check_for_proofs.rs` does a "final oracle check". In spv mode Arcade is the only
   oracle; the request fails with a transport error; the task logs *"timed out but oracle quorum
   inconclusive (…connection refused…) — forcing failure"* and then **marks the transaction failed,
   disables its outputs and restores its inputs as spendable.**
4. The wallet's balance is now wrong (979,660 real → 1,979,660 reported) and its next spend picks an
   input that is spent on chain. Arcade answers 202 and then `REJECTED … UTXO_SPENT`.
5. When Arcade is back, `monitor/task_unfail.rs` finds each transaction `MINED` and tries to recover
   it, and fails every time with *"proof does not match the header chain"*. The wallet does not heal.

So an outage of the only chain service, which should be an *error* ("cannot tell"), is treated as a
*verdict* ("failed"), and the recovery path that exists for exactly this cannot undo it.

## Evidence

- Wallet log (gitignored copy): `tests/cross-wallet/out/hodos-outage-2026-10-06/wallet.log`, from line
  ~4480: nine transactions "cleaned up (ghost outputs deleted, inputs restored)"; from line 4804,
  `task_unfail` "found MINED via Services chain! Recovering… Recovery failed … proof does not match
  the header chain" for each.
- Arcade (`GET :8080/tx/<txid>`) reports all nine `MINED` (heights 1159 and 1396), e.g.
  `99df9e8f4e5f1a8748b18e9a6ee4809565d2457a68515693876a385ff4a82a20` (1159) and
  `e797b08d2ce36440a2d45243bbde299171cf86bd37da85aa306755b52e87201e` (1396).
- The proofs are good: for both of those, `MerklePath.fromHex(merklePath).computeRoot(txid)` (the
  `@bsv/sdk`) equals the merkle root in the header the *wallet itself* returns from
  `getHeaderForHeight` at that height. So step 5's rejection is wrong.
- The follow-on spend: `67d830ed86a10ee1ed48f4d1e2afc81140e856b6b3869b572eb93f4d84c366a3` →
  `REJECTED`, `UTXO_SPENT (70): 8327616e…:2 utxo already spent by tx 622c61d8…` (one of the nine).

## Two defects

- **A — forced failure on an inconclusive oracle** (`task_check_for_proofs.rs`, the branch that logs
  "forcing failure", ~line 150). In spv mode a transport error from Arcade must leave the transaction
  pending and be retried; only a network verdict (`REJECTED`, `DOUBLE_SPEND_ATTEMPTED`) may fail it.
  Whether public mode (several oracles) should keep the forced failure is a separate question.
- **B — recovery rejects a valid proof** (`task_unfail.rs`, the path that converts Arcade's BUMP with
  `beef::parse_bump_hex_to_tsc` and stores it; the error text comes from
  `pending_proofs.rs :: storage_gate` → `ProofDecision::RejectBad`, i.e. the header-chain check
  returned `Ok(false)`). Cause not investigated further: the same BUMP verifies against the same
  header outside the wallet, so the TSC conversion or the check on this path is the suspect.

## Scope

Only seen in spv mode, where Arcade is the single oracle. On mainnet the same sequence needs an
Arcade outage (or the wallet being offline from it) that outlasts the timeout while transactions are
unproven: the wallet would then overstate its balance, lose sight of real change outputs, and build
spends the network rejects.

The test wallet that hit this is left as it was (scratch data dir) and is not used for later tests.
