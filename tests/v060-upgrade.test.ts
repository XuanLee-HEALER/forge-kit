import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auditFixture, message, tokenCount, tokens, withAudit } from "./helpers/audit-cli";
import { digest, historicalKit, releaseCLI } from "./helpers/historical-kit";
import { sandbox } from "./v05-sandbox";

test("T17 0.5.7 ledger, chain, Markdown and private model settings survive sync", () => {
  const s = sandbox();
  try {
    const old = join(historicalKit(s, "0.5.7"), "bin/forge");
    s.ok([old, "init", s.work]);
    s.git(s.work, "init", "-b", "main");
    const models = s.read(".workbench/models.toml").replace('model = "gpt-6.2-sol"', 'model = "fixture-tier-model"');
    s.privateFile(".workbench/models.toml", models);
    s.privateFile(".gitignore", "instance-user-file\n");
    s.ok([old, "sync", s.work]);
    const f = auditFixture(s);
    f.open("history");
    f.json("record", "history", "--kind", "note", "--status", "info", "--summary", "pre-upgrade receipt");
    const close = f.json("close", "history", "--summary", "legacy archive witness");
    const archive = close.archivePath as string;
    const legacy = readFileSync(archive);
    const before = f.status("history");
    expect(legacy.toString()).toContain("legacy archive witness");
    expect(f.json("verify", "--task", "history").ok).toBe(true);
    expect(existsSync(f.path("history"))).toBe(false);

    const candidate = releaseCLI(s);
    for (let pass = 0; pass < 2; pass += 1) {
      s.ok([candidate, "sync", s.work]);
      expect(JSON.parse(s.read(".workbench/kit-lock.json")).kit_version).toBe("0.6.1");
      expect(s.read(".workbench/models.toml")).toBe(models);
      expect(s.read(".codex/agents/implementer.toml")).toContain("fixture-tier-model");
      expect(s.read(".codex/hooks.json")).toContain("UserPromptSubmit");
      expect(JSON.parse(s.ok([s.forge, "instance", "show", "skill", "review", "--json"])).source).toBe("core");
      expect(JSON.parse(s.ok([s.forge, "instance", "show", "skill", "apply", "--json"])).source).toBe("core");
      expect(f.status("history")).toEqual(before);
      expect(f.json("verify", "--task", "history").ok).toBe(true);
      expect(readFileSync(archive)).toEqual(legacy);
      expect(s.git(s.work, "check-ignore", "instance-user-file").trim()).toBe("instance-user-file");
    }
    f.put("legacy-source", [message(1, "user", "legacy history fixture"), tokenCount(2, tokens(5, 2, 0, 3, 1))]);
    f.json("archive", "history", "--session", "legacy-source");
    expect(f.json("cost", "history", "--json").usage.total_tokens).toBe(8);
    expect(f.status("history")).toEqual(before);
    expect(readFileSync(archive)).toEqual(legacy);
    expect(s.git(s.work, "check-ignore", ".workbench/audit/history/trace.jsonl").trim()).toBe(".workbench/audit/history/trace.jsonl");
  } finally {
    s.cleanup();
    expect(existsSync(s.root)).toBe(false);
  }
}, 30_000);

test("T17 fresh installation ignores generated audit artifacts", () => withAudit(f => {
  f.s.git(f.s.work, "init", "-b", "main");
  f.open("hidden", ["--session-id", "hidden"]);
  f.put("hidden", [message(1, "user", "fresh installation content")]);
  f.json("archive", "hidden");
  for (const file of ["trace.jsonl", "summary.json", "summary.md"]) {
    const path = ".workbench/audit/hidden/" + file;
    expect(f.s.git(f.s.work, "check-ignore", path).trim()).toBe(path);
  }
}), 30_000);

test("T18 the historical 0.6.0 release carries its approved README", () => {
  const s = sandbox();
  try {
    const old = historicalKit(s, "0.6.0");
    expect(digest(join(old, "README.md"))).toBe("0f0627b1aa3bb2b9aadbf2e4801dafb0c38be30feb9e5b89baef40be7f1be65e");
  } finally { s.cleanup(); }
}, 30_000);

test("INV-08/09 sync preserves a 0.6.0 map-free workspace and reads old and new archive roles", () => {
  const s = sandbox();
  try {
    const old = join(historicalKit(s, "0.6.0"), "bin/forge");
    s.ok([old, "init", s.work]);
    s.git(s.work, "init", "-b", "main");
    s.ok([old, "add-repo", s.work, "--workbench", s.work]);
    const privateFile = s.read("AGENTS.local.md") + "\nHistorical private workspace sentence.\n";
    s.privateFile("AGENTS.local.md", privateFile);
    const oldCard = s.read(".workbench/root-repo.md").replace(/\n## Domain Index[\s\S]*$/, "\n");
    s.privateFile(".workbench/root-repo.md", oldCard);
    const f = auditFixture(s);
    f.open("old-cost", ["--session-id", "old-cost"]);
    f.put("old-cost", [message(1, "user", "fixture audit"), tokenCount(2, tokens(10, 2, 1, 5, 1))]);
    f.put("old-review", [tokenCount(2, tokens(9, 2, 1, 4, 2))], { parent: "old-cost", role: "reviewer" });
    f.json("close", "old-cost");
    const archive = f.path("old-cost", "summary.json");
    const original = digest(archive);
    const legacy = f.summary("old-cost");
    expect(Object.keys(legacy.by_role)).toHaveLength(9);
    expect(legacy.by_role.other.total_tokens).toBe(13);

    const candidate = releaseCLI(s);
    for (let pass = 0; pass < 2; pass += 1) {
      s.ok([candidate, "sync", s.work]);
      expect(JSON.parse(s.read(".workbench/kit-lock.json")).kit_version).toBe("0.6.1");
      expect(s.read("AGENTS.local.md")).toBe(privateFile);
      expect(s.read(".workbench/root-repo.md")).toBe(oldCard);
      expect(JSON.parse(s.ok([s.forge, "instance", "show", "skill", "apply", "--json"])).source).toBe("core");
      expect(f.json("verify", "--task", "old-cost").ok).toBe(true);
      expect(f.json("cost", "old-cost", "--json").by_role.other).toEqual(legacy.by_role.other);
      expect(digest(archive)).toBe(original);
    }

    f.open("new-cost", ["--session-id", "new-cost"]);
    f.put("new-cost", [tokenCount(1, tokens(30, 4, 3, 12, 3))]);
    f.put("new-review", [tokenCount(2, tokens(20, 8, 5, 10, 2))], { parent: "new-cost", role: "reviewer" });
    f.json("close", "new-cost");
    const cost = f.json("cost", "--days", "1", "--json");
    expect(cost.coverage).toMatchObject({ matched_tasks: 2, readable_summaries: 2, damaged_summaries: 0 });
    expect(cost.by_role.other.total_tokens).toBe(13);
    expect(cost.by_role.reviewer.total_tokens).toBe(30);
    expect(cost.usage.total_tokens).toBe(100);
    expect(digest(archive)).toBe(original);

    const { other: removed, ...missingRole } = legacy.by_role;
    expect(removed.total_tokens).toBe(13);
    f.s.privateFile(".workbench/audit/old-cost/summary.json", JSON.stringify({ ...legacy, by_role: missingRole }));
    expect(f.json("cost", "old-cost", "--json").coverage)
      .toMatchObject({ matched_tasks: 1, readable_summaries: 0, damaged_summaries: 1 });
    const partial = f.json("cost", "--days", "1", "--json");
    expect(partial.coverage).toMatchObject({ readable_summaries: 1, damaged_summaries: 1 });
    expect(partial.usage.total_tokens).toBe(72);
  } finally { s.cleanup(); }
}, 30_000);
