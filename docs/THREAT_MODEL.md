# Forge-kit trust boundaries

Forge-kit targets honest agents under pressure to finish and ordinary operator mistakes. An agent might weaken a frozen assertion, skip verification or report an unexecuted pass. An operator might select the wrong host, push main or reuse evidence from an earlier SHA. Runbook scope, evidence provenance and independent comparisons with Git make those mistakes observable.

## Controls in descending order of authority

1. Credentials and platform policy limit what a process can do. Use separate database grants and the read-only default of the dbcred capability broker. For production RW credentials, dbcred checks the trusted runtime session and the active runbook’s SQL host. Deployment owners deny secret access with Kubernetes RBAC and enforce GitHub branch/tag rulesets and required status checks.
2. UserPromptSubmit binds exact whole-message human approval to a pending runbook, its actions, a root session and an expiry.
3. Post-hoc Git tree, executable-bit and SHA-256 checks bind frozen artifacts and delivery evidence to the relevant checkout and revision.
4. wb-verify and forge-review execute checks and persist `source=tool` evidence. Targeted native review also records tool evidence. PostToolUse observes commits and verifies PR creation against the remote HEAD. Existing ledgers retain historical hook evidence. Manual attestations are labeled and cannot satisfy those checks. Legacy events fall back to their stored actor only when source is absent.
5. PreToolUse is a safety belt for recognizable operations. Its parser does not establish an adversarial execution sandbox. A deliberately obscured shell pipeline, a Git alias or dynamically expanded command falls outside this parser's threat model. Production authority must be restricted even when the hook never runs.

## PR handoff and batch release

Handoff binds each repository and branch to a verified HEAD, PR URL, target branch and ledger tip. Release verification reuses those receipts and queries the live PR. A head mismatch produces `STALE_PR`. A surviving local branch must still match the handoff. After a merge, the verified commit must be reachable from the pinned target branch’s remote-tracking ref, including when the feature branch has been removed.

The release thread collects PRs, SQL and requested tags in one runbook. Approval revalidates release items and action bindings before the runbook can confer production authority. Production `dbcred --rw` requires an active approval in the trusted session for the specific SQL host. Release completion checks merge evidence, required production results and action receipts, then closes the release and all its handed-off children in one SQLite transaction.

## Unattended fast-track

The operator controls the write-protected `.workbench/ship-policy.yaml`. An agent may prepare an envelope. Only a whole-message human approval in the root session activates it through UserPromptSubmit. The approval binds the session and expiry. `policy_hash` covers the policy bytes and `scope_hash` binds the task, endpoint, frozen specification, freeze sequence, repositories, paths and policy hash.

`forge-ship` checks eight conditions before delivery:

1. The envelope is active, unexpired, bound to the current session and consistent with the live policy and recorded scope.
2. The task is open, the frozen specification matches and locked tests have no drift.
3. Attached checkouts are clean. Changes fit the approved repositories and paths, including both sides of renames.
4. Changes avoid forbidden paths. Gitlinks are refused because a parent diff cannot bound the submodule’s changes.
5. Unique paths and actual added plus deleted lines fit the blast-radius limits.
6. Verification and required independent review have tool-backed evidence at the feature HEAD being delivered. Open blockers prevent delivery.
7. Fast-track grants no production SQL or database write credentials. With the default `forbid_db_rw: true`, the production runbook contains no SQL actions.
8. Production requires explicit opt-in, matching live PR pins and green required CI. The runner checks the prospective merge or verified merged result, and checks the live target before authorizing a tag.

A violation on an active envelope records `DEGRADED` with the reason for human takeover. Fast-track authority expires at `expires_at`. Evaluating an `ACTIVE` envelope or attempting to redeem it after expiry changes its stored status to `EXPIRED`. The read-only `ledger fast-track status` command reports the stored row. A durable claim makes redemption single-use. FAT push receipts let an operator reconcile a partial delivery or a push already in flight at revocation.

## Ledger integrity

SQLite transactions and the per-task SHA-256 chain detect accidental corruption and inconsistent history. An independently retained Ledger-Tip provides a witness for the anchored prefix. A process with the same OS user's filesystem privileges can rewrite the database and recompute a local chain. Protect external witnesses and privileged credentials separately.
