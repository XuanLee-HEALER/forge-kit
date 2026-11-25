# forge-kit

Codex-native, self-contained multi-repo engineering workbench kit built with **Bun + TypeScript** and **SQLite (WAL)**.

## What It Provides

- **Lean Constitutional Entry (`AGENTS.md`, < 8 KB)** — well under Codex's 32 KiB cap, paired with instance-private `AGENTS.local.md` and per-repo cards (`.workbench/repos/*.md`).
- **Declarative Codex Config (`.codex/`)** — local `config.toml`, declarative role agents (`dev.toml`, `scanner.toml`, `analyst.toml`, `spec-reviewer.toml`), and `hooks.json` matching `codex-cli 0.169.1` schemas.
- **SQLite (WAL) Per-Task Hash-Chained Ledger (`.workbench/bin/ledger`)** — append-only SHA-256 hash chain per `task_id`, DB-level `BEFORE UPDATE` immutability trigger, FTS5 search, `(repo, branch)` routing (multi-thread safe), and whole-task physical `prune` without breaking remaining chains.
- **Production authority** — dbcred defaults to read-only access. Production write credentials require an active, session-bound Runbook with the approved SQL host. A human approves the exact actions in a standalone message.
- **Delivery evidence** — Git tree, mode and SHA-256 comparisons detect drift in frozen artifacts. On a clean checkout, wb-verify runs checks and forge-review runs independent reviews, recording source=tool evidence for the current revision.
- **Lifecycle hooks** — PreToolUse blocks recognizable unsafe writes, protected Git/GitHub and cluster operations, and checks delivery readiness. PostToolUse observes commits and verifies PR creation against remote HEAD. Session start and compaction restore the active ledger summary.
- **Portable Meta-Project (`review-agents` Git Submodule)** — 4 independent read-only advisory review CLIs wired via **relative symlinks** into `.agents/skills/`, with unified 4-role native read-only fallback on exact `credit_balance_exhausted`.

See the [threat model](docs/THREAT_MODEL.md) for enforcement boundaries and the [modular architecture](docs/MODULAR_ARCHITECTURE.md) for the source layout. The full test command runs both the workbench and independent review suites.

## v0.4 delivery workflows

| Choose this workflow when… | How delivery finishes |
|---|---|
| **Single-thread delivery** — one feature owner follows the change to its authorized endpoint | Run `wb-verify` and `forge-review`, deliver to FAT or PR, or obtain human runbook approval for production. Close the task after acceptance. |
| **PR handoff and batch release train** — multiple verified features ship together | Each feature thread runs `ledger handoff` and posts the returned PR trailers. The release thread verifies live PR heads, obtains one runbook approval and closes the batch with execution receipts. |
| **Unattended fast-track** — an operator can approve the frozen scope in advance | Set limits in `.workbench/ship-policy.yaml`, prepare an envelope with `ledger fast-track prepare`, then use `forge-ship evaluate` and `forge-ship run` in the approving session. A PR feeds the release train. |

The standard model tier defaults to `gpt-6.2-astra` with `medium` reasoning effort. Customize it in the workbench’s `.workbench/models.toml`. [Delivery commands and completion criteria](core/.agents/skills/ship/SKILL.md)

## Quick Start

```bash
# 1. Build standalone Bun bundles inside forge-kit
git submodule update --init --recursive
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
