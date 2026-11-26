# review-agents

Run a fixed-commit review from a Bun workspace or its standalone distribution.

```sh
review-agents/bin/review --repo ./project --base "$BASE" --head "$HEAD" --spec ./requirements.md --roles business,quality --mode ordered --order quality,business
```

The default runs business, quality, simplify (including performance), and comments in parallel. Serial mode uses the listed role order. Ordered mode requires an exact permutation of the requested roles. Every role starts with the same pinned materials; business also requires a readable specification. Both backends receive identical repository data. For up to eight changed source files the engine selects relative module dependencies and searches the pinned head for callers of changed declarations. It attaches numbered snippets from up to twelve unchanged source files (4 KiB each), excluding private workspace data and instruction files. Missing private, binary or oversized diff materials produce incomplete results. Model reports identify blocking findings and suggestions on changed paths.

Auto starts a fresh ephemeral read-only Codex CLI for each role. A recognized provider outage or quota failure allows a single API attempt. Explicit `--backend codex` and `--backend api` select one backend. The Codex executable comes from PATH or `FORGE_CODEX_BIN`. The API expects `OPENAI_API_KEY` or a private TOML file at `REVIEW_CONFIG` (default `~/.config/review-agents/config.toml`) with `openai.api_key`. A compatible Responses endpoint can be configured with `OPENAI_BASE_URL`. Use `--model` and `--effort` to select the runtime model. Exit codes are 0 for pass, 1 for blocked, 2 for execution error and 3 for incomplete.

From this directory run `bun run check`, `bun run build`, and `bun test tests`. Run `bun run eval` for offline contract checks or `bun run eval --live` for paired real-model scores. Live evaluation runs both providers on the four labeled defects and their clean controls. Each returned record includes the exact material revision, role, actual provider, result, and score.
