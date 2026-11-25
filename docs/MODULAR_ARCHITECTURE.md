# Forge-kit v0.3 module map

The four domain layers form an acyclic graph. Dependencies point from consumers toward their prerequisites. CLI entrypoints compose these layers.

```text
hooks     → ledger, shared
guard     → ledger, shared
ledger    → shared
shared    → core utilities and runtime
```

| Layer | Modules | Responsibilities |
|---|---|---|
| Shared | shared/shell, git-cmd, gh-remote, path | Parse recognizable shell and Git/GitHub arguments, resolve repository identities and paths |
| Shared | shared/go, make, pkg-manager, test-inputs, tsc | Validate inputs to active verification runners |
| Ledger | ledger/types, transactions, schema, store, checkout | Persist and verify the per-task event chain, attachments, evidence and delivery readiness |
| Ledger | ledger/spec, locked-tests, runbook | Bind frozen content to Git and SHA-256, check drift, manage session-scoped approvals |
| Ledger | ledger/execution, delivery-tools, review-fallback, stats, fat-merge | Bind execution to clean revisions, verify remote PRs, conduct targeted reviews, report stats and tips, integrate FAT updates |
| Guard | guard/evaluate, runbook-state, sql-http, infra, git-gh, tamper, spec-lock, ledger-gate | Apply a seven-second fail-closed budget, physical fuses, literal file locks and the ledger delivery gate |
| Hooks | hooks/types, classify, runbook-prompt | Observe commits and remotely verified PR creation, restore session summaries and process whole-message human directives |

The public facades are src/guard.ts, src/ledger.ts and src/ledger-hook.ts. The eleven build entrypoints in src/bin are cli, ledger, ledger-hook, guard, wb-git, dbcred, cmdfmt, lang-check, wb-verify, forge-review and forge-ship. The ship runner evaluates and redeems human-approved scopes through the ledger. PostToolUse has no package-manager, runner, manifest or review-output parser.

## Verification checklist

1. Run `bun run check && bun run build && bun run test:all`. Check TypeScript, build and tests independently inside review-agents.
2. Run the workbench suite with unreadable HOME and GH_CONFIG_DIR and an empty FORGE_WORKBENCH_ROOT.
3. Check the complete local import graph for cycles and upward layer dependencies, and confirm all three facade export surfaces.
4. Check `wc -l src/guard/*.ts` totals at most 1,500 and `wc -c < core/AGENTS.md` is below 8,000. Scan distributable files for private identifiers and check both repositories with git diff --check.
