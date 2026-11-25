# Forge-Kit Modular Architecture & Refactoring Principles

This document defines the logical layering, dependency rules, and module boundaries for `forge-kit/src/`. Its goal is **controlled change blast radius** for both humans and coding agents: any bug fix or feature change should touch 1–2 cohesive domain modules rather than a 3,000–5,000 line monolith.

## 1. Core Principles

1. **Organize by logical responsibility & change reason, not arbitrary line counts.**
   - A module exists because it owns one cohesive domain concept (e.g., POSIX shell lexing, Git/GH CLI parsing, SQL production-DB guard, SQLite ledger schema, package-manager CLI parsing).
   - Never split a coherent state machine across files purely to hit a line quota; never merge unrelated domains into one file.
2. **Strict Acyclic Layering (DAG — Zero Circular Dependencies).**
   - Every import MUST flow downward from a higher layer to a lower layer (or within the same layer only along a documented acyclic order).
   - Lower layers MUST NEVER import from higher layers.
   - Eliminating upward/lateral cycles prevents Temporal Dead Zone (TDZ) initialization bugs and keeps unit tests and bundles deterministic.
3. **Single Source of Truth for Shared Parsers.**
   - Shell lexing, Git command parsing, GitHub remote/PR parsing, and OS path canonicalization belong in `src/shared/`.
   - Guards (`src/guard/`) and Hooks (`src/hooks/`) MUST share the exact same parser primitives from `src/shared/` so PreToolUse gates and PostToolUse evidence attribution never drift.
4. **Thin Compatibility Facades at Public Entrypoints.**
   - `src/guard.ts`, `src/ledger.ts`, and `src/ledger-hook.ts` remain thin re-export facades preserving 100% of existing public symbols and signatures.
   - `src/bin/*.ts`, `src/cli.ts`, and `tests/*.test.ts` continue to work without breaking imports.
5. **Pure Structural Refactoring Invariant (Zero Behavior Drift).**
   - When refactoring structure, do NOT change security semantics, error messages, CLI flags, SQLite schema, or hook JSON formats.
   - Every existing test (103/103 across main + `review-agents`) and all 8 `bun build` entrypoints MUST pass unchanged.

---

## 2. Dependency Layers (Strict DAG)

```text
Layer 4: CLI Binaries & Top-Level Facades
  src/bin/*.ts, src/cli.ts, src/wb-git.ts
  src/guard.ts (facade), src/ledger.ts (facade), src/ledger-hook.ts (facade)
         │
         ▼
Layer 3: Passive Lifecycle Hooks (PostToolUse / SessionStart / PostCompact / UserPromptSubmit)
  src/hooks/
         │
         ▼
Layer 2: PreToolUse Guard Policies (Physical Fuses & Ledger Delivery Gate)
  src/guard/
         │
         ▼
Layer 1: Ledger Domain (SQLite WAL Store, Schema/Verify, Spec Freeze, Runbooks, CLI)
  src/ledger/
         │
         ▼
Layer 0: Shared Primitives & Core Utilities (No dependency on Layers 1–3)
  src/shared/ (shell, git-cmd, gh-remote, path)
  src/config.ts, src/git.ts, src/hook-io.ts, src/lang-check.ts, src/cmdfmt.ts, src/dbcred.ts
```

**Hard Dependency Rules:**
- `src/shared/*` may ONLY import Node/Bun builtins, `src/config.ts`, `src/git.ts`, and sibling `src/shared/*` (acyclic: `path` ← `shell` ← `git-cmd` / `gh-remote`).
- `src/ledger/*` may ONLY import Layer 0 (`src/shared/*`, `src/config.ts`, `src/git.ts`, `src/lang-check.ts`). Never `src/guard/*` or `src/hooks/*`.
- `src/guard/*` may ONLY import Layer 0 and Layer 1 (`src/ledger/*`). Never `src/hooks/*`.
- `src/hooks/*` may ONLY import Layer 0, Layer 1 (`src/ledger/*`), and (if strictly needed for shared guard helpers like `ApprovedRunbookEntry` or `extractGhPrSubcommand` — prefer `src/shared/*`!) never create cycles back into `src/guard/*`.

---

## 3. Target Module Map

### Layer 0 — `src/shared/`
| Module | Cohesive Responsibility |
|---|---|
| `src/shared/path.ts` | `canonicalizeOsPath` (`realpathSync.native`), `canonicalizeMaybePath`, `sha256File`, `matchesGlob` |
| `src/shared/shell.ts` | `ShellToken`, ANSI-C decoding, `splitShellTokensWithMeta`, `splitShellTokens`, `splitShellSegments`, `stripUnquotedShellRedirections`, `hasUnquotedRedirect`, `hasUnquotedPipe`, `hasOnlyAndSeparators`, `hasShellExpansion`, `unwrapShellPrefix`, `expandEnvSplitStrings`, `resolveSegmentCwd`, `hasPrecedingDynamicCd` |
| `src/shared/git-cmd.ts` | `resolveGitDirFlags`, `extractGitSubcommand`, `extractCommandPositionGit`, `parseGitPushArgs`, `evaluateFollowTagsSetting`, `isFollowTagsEffective`, `resolveEffectivePushRemote`, `isImplicitPushAmbiguous`, `effectivePushRepo`, `parseGitTagCreation`, `repoOrigin`, `getCanonicalGitCommonDir` |
| `src/shared/gh-remote.ts` | `parseGitRemoteRepo`, `parseGhRepoSpec`, `resolveGhDefaultHost`, `qualifyGhRepoSpec`, `resolveGhDefaultRepo`, `ghDefaultMatchesOrigin`, `extractGhPrSubcommand`, `ParsedGhPrCreateArgs`, `parseGhPrCreateArgs`, `parseGhPrMergeTarget` |

### Layer 1 — `src/ledger/` (Facade: `src/ledger.ts`)
| Module | Cohesive Responsibility |
|---|---|
| `src/ledger/types.ts` | Public interfaces/types (`TaskRecord`, `TaskRepoRecord`, `TaskBlockerRecord`, `EventRecord`, `ExemptionRecord`, `RunbookStatus`, `RunbookActions`, `RunbookRecord`, etc.), `nowIso`, `canonicalJson`, `computeEntryHash`, `ledgerDbPath` |
| `src/ledger/schema.ts` | SQLite WAL DDL, triggers, migrations, and standalone `verify()` hash-chain verification helpers |
| `src/ledger/spec.ts` | Spec freeze / disk drift / amend scope radiation / locked test-glob helpers |
| `src/ledger/runbook.ts` | Release Runbook lifecycle helpers (create, approve, complete, revoke, active session queries, kubectl normalization) |
| `src/ledger/store.ts` | `Ledger` class composing `schema`, `spec`, and `runbook` operations with unchanged public method surface |
| `src/ledger/cli.ts` | `runLedgerCli()` CLI argument parsing & subcommand routing |

### Layer 2 — `src/guard/` (Facade: `src/guard.ts`)
| Module | Cohesive Responsibility |
|---|---|
| `src/guard/runbook-state.ts` | `ApprovedRunbookEntry`, `loadApprovedRunbooksForSession` |
| `src/guard/tamper.ts` | `checkLedgerTamper`, `isReadonlyLedgerHookInspection`, `apply_patch` ledger path protection |
| `src/guard/sql-http.ts` | `isHttpWriteCommand`, SQL client/DSN/URI/conninfo parsing, `parseApprovedSqlMigrationCommand`, `extractCheckProdDbHosts`, `isSafeWorkbenchLedgerCliCommand`, `checkProdDb` |
| `src/guard/infra.ts` | `checkKubectl`, `checkCloudAndRedisOps` |
| `src/guard/git-gh.ts` | `isApprovedTagPushRefspec`, `checkGitAndGh` |
| `src/guard/spec-lock.ts` | Frozen spec & locked test-glob write protection across `apply_patch`, shell redirects, and inline scripts |
| `src/guard/ledger-gate.ts` | Tier 2 passive dev ledger gate (`checkLedgerGate`, `evaluateDiffExemptEligibility`, detached FAT merge worktree tracing) |
| `src/guard/evaluate.ts` | `evaluatePreToolUse`, `runGuardCli` |

### Layer 3 — `src/hooks/` (Facade: `src/ledger-hook.ts`)
| Module | Cohesive Responsibility |
|---|---|
| `src/hooks/types.ts` | `CapturedEvidence`, `ScriptKind`, `VerificationHit`, `ReportPhase`, shared hook constants (`BENIGN_TRAILING_CMDS`, `SHELL_CONTROL_OR_STATE_BUILTINS`) |
| `src/hooks/pkg-manager.ts` | `ParsedPkgManager`, `NPM_VALUE_FLAGS`, `BUN_BUILD_VALUE_FLAGS`, `parsePkgManagerInvocation`, `resolvePkgManagerEffectiveDir`, `npmCliBoolean`, `ignoresLifecycleScripts`, `findNearestPackageDir`, `isScriptNameKind`, `getScriptKind` |
| `src/hooks/runners.ts` | Language & runner parsers (`lang-check`, `tsc`, `eslint`, `go`, `pytest`, `node --test`, `vitest`, `svelte-check`, `make`, `just`, `hurl`), `parseLangCheckPhases`, `classifyVerifyCommand`, `resolveVerifyTargetDir` |
| `src/hooks/manifest-verify.ts` | Shell control-flow checks (`isFailFastSetSegment`, `hasAmbiguousControlFlow`), `canVerifyCommandMutateFiles`, `safeTrailingSegments`, `hasExecutingScriptSegment`, `hasInfoOnlyFlag`, `hasNonExecutingVerifyFlag` |
| `src/hooks/review-evidence.ts` | `review-agents` CLI & `codex review` command parsing, `parseReviewJsonOutput`, `normalizeReviewRole` |
| `src/hooks/runbook-prompt.ts` | `UserPromptSubmit` human approval directive handling (`handleUserPromptRunbookDirectives`) |
| `src/hooks/classify.ts` | `classifyPostToolEvidence`, `handleLedgerHook`, `runLedgerHookCli` |

---

### Implementation dependency order

- Shared primitives build from `path` and `shell` to `gh-remote`, then `git-cmd`. Git push resolution uses the same remote URL parser as GH. The Git top-level query lives with the Git primitives. Shell helpers shared by hook runners live in `shell`.
- In the ledger, `types` defines the read interface used by domain operations. `transactions` owns the immediate transaction and in-transaction event append shared by schema initialization, the store, spec changes and runbooks. These modules take the existing connection or reader so they do not import the concrete store. `store` composes them and `cli` calls the store. Review-role normalization stays in the ledger because both ledger writes and hooks use it.
- The independent guard policies feed `evaluate`. The tamper check uses the SQL write detector, and the ledger gate uses the Git/GH delivery parsers and runbook state. The existing `wb-git.ts` CLI uses the ledger and is grouped with the entrypoints.
- Hook verification flows from `types` to `pkg-manager`, `runners`, `manifest-verify`, and `classify`. The shared info-only flag predicate lives with runner parsing because Hurl uses it too. Review evidence and runbook prompts are independent inputs to `classify`.

## 4. Verification Checklist for Any Modular Refactor

1. **Zero behavior change**: `bun run check && bun run build && bun run test:all` exits 0 with all tests passing unchanged.
2. **Zero circular dependencies**: Static import-graph check across `src/` confirms 0 cycles and 0 layer violations (no `shared` → `ledger`/`guard`/`hooks`, no `ledger` → `guard`/`hooks`, no `guard` → `hooks`).
3. **100% public export parity**: Every symbol previously exported by `src/guard.ts`, `src/ledger.ts`, and `src/ledger-hook.ts` remains exported from those facade files with identical signatures.
4. **Clean build artifacts**: All 8 `dist/*.js` entrypoints build cleanly via `bun run build`.
5. **No duplication**: Shared helpers (`canonicalizeOsPath`, `unwrapShellPrefix`, `extractGhPrSubcommand`, `parseGitRemoteRepo`, `parseGhRepoSpec`, etc.) live in ONE canonical module in `src/shared/`.
6. **Zero private leaks & clean workspace**: `core/AGENTS.md` unchanged (9,947 bytes), zero private identifiers, zero untracked temporary files.
