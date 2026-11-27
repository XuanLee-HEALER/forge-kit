# review-agents

Review changes between two Git commits with a fresh read-only Codex CLI process for each role and batch. Supply both the model and reasoning effort.

```sh
review-agents/bin/review --repo ./project --base "$BASE" --head "$HEAD" \
  --spec ./requirements.md --roles business,quality --mode ordered \
  --order quality,business --model gpt-6.2-sol --effort medium
```

The default runs business, quality, simplify (including performance), and comments in parallel. Serial mode uses the canonical role order. Ordered mode requires an exact permutation of the selected roles. Business requires a readable specification. Set `FORGE_CODEX_BIN` to select a Codex executable. The subprocess runs in its own temporary directory with project instructions, user configuration and tools disabled.

The engine inventories changed paths, rename pairs, Git modes and line counts at the selected commits. Each batch includes an inventory summary, related changes, numbered fixed-revision caller or dependency excerpts where available, and the actual patch chunks. Deletion chunks carry the old-file positions. Large files and long lines span multiple chunks. Every role acknowledges its own chunks. Excluded private files, binary changes and missing or invalid batch receipts appear in an incomplete report. The report retains validated findings from earlier batches. Each finding identifies a line within a delivered patch range.

Exit codes are 0 for pass, 1 for blocking findings with complete coverage, 2 for invalid invocation, and 3 for incomplete review. Forge records role selections, executions, versions, findings and gaps in its task ledger.

## Running and developing the package

The archive includes the launcher and self-contained bundle. Unpack it and run `./bin/review` with Bun, Git and authenticated Codex CLI on PATH. In a source checkout use `bun src/review.ts` to run source changes or `bun run build` to refresh the bundle.

For workspace development, run `bun install --frozen-lockfile` at the forge-kit root. For a standalone copy, install with the packaged lockfile.

```sh
cp standalone/bun.lock bun.lock
bun install --frozen-lockfile
```

Run `bun run check`, `bun run build` and `bun test tests` from this directory. Run `bun run eval` to exercise delivery and scoring through a deterministic subprocess. Run `bun run eval --live` to measure Codex on the four labeled defects and four clean controls. Both modes use the same material, location, severity and diagnosis criteria.
