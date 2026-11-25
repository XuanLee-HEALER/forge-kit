# forge-kit

Codex-native, self-contained multi-repo engineering workbench kit built with **Bun + TypeScript** and **SQLite (WAL)**.

## What It Provides

- **Lean Constitutional Entry (`AGENTS.md`, < 8 KB)** — well under Codex's 32 KiB cap, paired with instance-private `AGENTS.local.md` and per-repo cards (`.workbench/repos/*.md`).
- **Declarative Codex Config (`.codex/`)** — local `config.toml`, declarative role agents (`dev.toml`, `scanner.toml`, `analyst.toml`, `spec-reviewer.toml`), and `hooks.json` matching `codex-cli 0.169.1` schemas.
- **SQLite (WAL) Per-Task Hash-Chained Ledger (`.workbench/bin/ledger`)** — append-only SHA-256 hash chain per `task_id`, DB-level `BEFORE UPDATE` immutability trigger, FTS5 search, `(repo, branch)` routing (multi-thread safe), and whole-task physical `prune` without breaking remaining chains.
- **3-Tier Passive Guard & Auto-Evidence Hooks (`.workbench/bin/guard`, `ledger-hook`)**:
  - **Tier 1 (PreToolUse safety belt)**: blocks prod DB writes (PG / MySQL / ClickHouse), non-readonly `kubectl` & comma-separated `secret` reads, `git push` tags/protected branches, `gh pr merge`, destructive shared-worktree git commands, and direct `.workbench/ledger/` tampering.
  - **Tier 2 (Dev Ledger Gate)**: active only on registered business repos; requires ledger binding (or tiny non-logic exemption) before `git commit` and verified SHA / zero blockers before `git push` or `gh pr create`. Zero friction on ops, DB queries, logs, or `one-off-scripts/`.
  - **Tier 3 (Auto-Evidence & Amnesia Immunity)**: captures real `git commit`, build/test/lint, and `review-agents` outcomes on `PostToolUse`, and re-injects active ledger summaries on `SessionStart` & `PostCompact`.
- **Portable Meta-Project (`review-agents` Git Submodule)** — 4 independent read-only advisory review CLIs wired via **relative symlinks** into `.agents/skills/`, with unified 4-role native read-only fallback on exact `credit_balance_exhausted`.

See the [threat model](docs/THREAT_MODEL.md) for enforcement boundaries and the [modular architecture](docs/MODULAR_ARCHITECTURE.md) for the source layout. The full test command runs both the workbench and independent review suites.

## Quick Start

```bash
# 1. Build standalone Bun bundles inside forge-kit
bun install
bun run build
bun run test:all

# 2. Initialize a clean self-contained workbench in any empty directory
./bin/forge init ~/work/my-garage --name my-garage --git-org my-org --packs dbop,comm-lark

# 3. Clone a business repo and register it (auto-generates repo card + updates workbench.yaml)
git clone <repo-url> ~/work/my-garage/backend
./bin/forge add-repo ~/work/my-garage/backend

# 4. Run health checks (AGENTS size, TOML/JSON validity, relative symlinks, secret scan, ledger chain)
./bin/forge doctor ~/work/my-garage

# 5. Later: pull kit updates without touching instance-private files
./bin/forge sync ~/work/my-garage
```

## Submodule Setup (`review-agents`)

`review-agents` is tracked as a Git submodule (`url = ../review-agents.git`). When pushing `forge-kit` to your remote Git host, push your `review-agents` repo alongside it (or update `.gitmodules` via `git submodule set-url review-agents <url>`).
