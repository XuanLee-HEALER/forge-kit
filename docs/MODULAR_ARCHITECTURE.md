# Forge-kit v0.4 module map

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
| Ledger | ledger/handoff, pr, release, release-inspection | Capture handoff witnesses, verify live PR pins, assemble release runbooks and validate execution receipts before batch close |
| Ledger | ledger/fast-track, review-range, cli | Bind and transition scope envelopes, check review coverage and dispatch ledger commands |
| Guard | guard/evaluate, runbook-state, sql-http, infra, git-gh, tamper, spec-lock, ledger-gate | Apply a seven-second fail-closed budget, physical fuses, literal file locks and the ledger delivery gate |
| Hooks | hooks/types, classify, runbook-prompt | Observe commits and remotely verified PR creation, restore session summaries and process whole-message human directives |

SQLite schema v5 stores PR handoffs in `task_handoffs`, release batches and their pinned items in `releases` and `release_items`, and single-use authorities in `fast_track_envelopes`. The existing task event chain records approvals, state changes and delivery receipts.

## CLI entrypoints

Each row maps an installed `.workbench/bin` command to its build entrypoint under `src/bin/`.

| Command | Entrypoint | Responsibility |
|---|---|---|
| forge | cli.ts | Initialize, sync, register repositories and run doctor |
| ledger | ledger.ts | Manage tasks, evidence, handoffs, releases, runbooks and envelopes |
| ledger-hook | ledger-hook.ts | Route lifecycle events into the ledger |
| guard | guard.ts | Evaluate PreToolUse authorization |
| wb-git | wb-git.ts | Inspect worktrees, integrate FAT branches and sweep |
| dbcred | dbcred.ts | Resolve read-only or approved scoped database credentials |
| cmdfmt | cmdfmt.ts | Format shell commands for inspection |
| lang-check | lang-check.ts | Run repository language checks |
| wb-verify | wb-verify.ts | Capture tool-backed checks at a clean revision |
| forge-review | forge-review.ts | Run independent reviews and record their evidence |
| forge-ship | forge-ship.ts | Dispatch to `src/forge-ship.ts` for scope evaluation and redemption |

The v0.4 M3 graph has 68 TypeScript source files and 261 local dependency edges, zero cycles and zero layer violations. The public facades `src/guard.ts`, `src/ledger.ts` and `src/ledger-hook.ts` retain their 27, 30 and 4 exports respectively. Guard sources total 1,490 lines against a 1,500-line ceiling. The managed AGENTS template uses 7,405 of its strict 8,000-byte limit.

## Verification checklist

1. Run `bun run check && bun run build && bun run test:all`. Check TypeScript, build and tests independently inside review-agents.
2. Run the workbench suite with unreadable HOME and GH_CONFIG_DIR and an empty FORGE_WORKBENCH_ROOT.
3. Check the complete local import graph for cycles and upward layer dependencies, and confirm all three facade export surfaces.
4. Check `wc -l src/guard/*.ts` totals at most 1,500 and `wc -c < core/AGENTS.md` is below 8,000. Scan distributable files for private identifiers and check both repositories with git diff --check.
