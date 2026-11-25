# Forge-kit trust boundaries

Forge-kit targets honest agents under pressure to finish and ordinary operator mistakes. An agent might weaken a frozen assertion, skip verification or report an unexecuted pass. An operator might select the wrong host, push main or reuse evidence from an earlier SHA. Runbook scope, evidence provenance and independent comparisons with Git make those mistakes observable.

## Controls in descending order of authority

1. Credentials and platform policy limit what a process can do. Use separate database grants and the read-only default of the dbcred capability broker. For production RW credentials, dbcred checks the trusted runtime session and the active runbook’s SQL host. Deployment owners deny secret access with Kubernetes RBAC and enforce GitHub branch/tag rulesets and required status checks.
2. UserPromptSubmit binds exact whole-message human approval to a pending runbook, its actions, a root session and an expiry.
3. Post-hoc Git tree, executable-bit and SHA-256 checks bind frozen artifacts and delivery evidence to the relevant checkout and revision.
4. wb-verify and forge-review execute checks and persist `source=tool` evidence. Targeted native review also records tool evidence. PostToolUse observes commits and verifies PR creation against the remote HEAD. Existing ledgers retain historical hook evidence. Manual attestations are labeled and cannot satisfy those checks. Legacy events fall back to their stored actor only when source is absent.
5. PreToolUse is a safety belt for recognizable operations. Its parser does not establish an adversarial execution sandbox. A deliberately obscured shell pipeline, a Git alias or dynamically expanded command falls outside this parser's threat model. Production authority must be restricted even when the hook never runs.

## Ledger integrity

SQLite transactions and the per-task SHA-256 chain detect accidental corruption and inconsistent history. An independently retained Ledger-Tip provides a witness for the anchored prefix. A process with the same OS user's filesystem privileges can rewrite the database and recompute a local chain. Protect external witnesses and privileged credentials separately.
