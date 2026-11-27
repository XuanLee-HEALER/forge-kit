# review-agents

Run a fixed-commit review from a Bun workspace or its standalone distribution. The launcher runs the built bundle when present. In a source checkout, use `bun src/review.ts` to run changes directly or `bun run build` to refresh the bundle.

```sh
review-agents/bin/review --repo ./project --base "$BASE" --head "$HEAD" --spec ./requirements.md --roles business,quality --mode ordered --order quality,business
```

The default runs business, quality, simplify (including performance), and comments in parallel. Serial mode uses the listed role order. Ordered mode requires an exact permutation of the requested roles. Every role starts with the same pinned materials; business also requires a readable specification. Both backends receive identical repository data. For up to eight changed source files the engine selects relative module dependencies and searches the pinned head for callers of changed declarations. It attaches numbered snippets from up to twelve unchanged source files (4 KiB each), excluding private workspace data and instruction files. The engine limits each changed blob and the combined numbered diff to 1,500,000 bytes. If material cannot fit, it stops opening subsequent diffs and lists unread paths in the incomplete result. Private directories are recognized at any workspace depth. A changed public `.agents/skills/<id>/SKILL.md` remains reviewable outside private ancestors. Private or binary material also yields an incomplete result. The report includes every selected role. An empty `attempts` array means that no backend started for that role. Forge records these unstarted selections as `review_selection` with `missing_materials`. The review history lists them alongside executed `review` records. Delivery waits for a successful execution of the same role and range. Each finding must identify a line in the pinned head file, or its base version for deletions. Invalid locations produce a role execution error. Each role returns its validated `limitations` alongside the findings. Forge retains these limitations in review evidence and displays them in `forge ledger reviews <task-id>`.

Auto starts a fresh ephemeral read-only Codex CLI for each role. A recognized provider outage or quota failure allows a single API attempt. Explicit `--backend codex` and `--backend api` select one backend. The Codex executable comes from PATH or `FORGE_CODEX_BIN`. Its subprocess receives an allowlist of runtime, proxy/TLS and provider-authentication settings, including `HOME`, `CODEX_HOME`, `CODEX_API_KEY` and `OPENAI_API_KEY`. The API expects `OPENAI_API_KEY` or a private TOML file at `REVIEW_CONFIG` (default `~/.config/review-agents/config.toml`) with `openai.api_key`. A compatible Responses endpoint can be configured with `OPENAI_BASE_URL`. Use `--model` and `--effort` to select the runtime model. Exit codes are 0 for pass, 1 for blocked, 2 for execution error and 3 for incomplete.

## Running and developing the package

The built archive includes `bin/review` and its self-contained `dist/review.js`. Unpack it and invoke `./bin/review` with Bun and Git on PATH. You can skip dependency installation and compilation for this entry point. A real review also requires access to the selected provider.

For source development in forge-kit, run `bun install --frozen-lockfile` once at the workspace root. Bun uses the root lockfile to install both packages. For a standalone copy outside a workspace, run these commands in the review package directory. The nested lockfile travels with the archive because Bun 1.4.4 excludes a package-root `bun.lock` when packing.

```sh
cp standalone/bun.lock bun.lock
bun install --frozen-lockfile
```

The source entry point, build, tests and evaluation use OpenAI and Zod from `node_modules`. A production-only install (`bun install --production --frozen-lockfile` with the appropriate lockfile in place) supplies those libraries. Static checking also needs TypeScript and the Bun type definitions from the full development install.

From this directory run `bun run check`, `bun run build`, and `bun test tests`. Run `bun run eval` to score four labeled defects and their clean controls through the Codex subprocess adapter and a loopback Responses API. Offline results use deterministic simulated providers. Run `bun run eval --live` to score the same inputs with real models. Each returned record includes the exact material revision, role, actual provider, result, and score.
