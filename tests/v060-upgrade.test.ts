import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { auditFixture, message, tokenCount, tokens, withAudit } from "./helpers/audit-cli";
import { digest, historicalKit, releaseCLI } from "./helpers/historical-kit";
import { kit, sandbox } from "./v05-sandbox";

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
      expect(JSON.parse(s.read(".workbench/kit-lock.json")).kit_version).toBe("0.6.0");
      expect(s.read(".workbench/models.toml")).toBe(models);
      expect(s.read(".codex/agents/implementer.toml")).toContain("fixture-tier-model");
      expect(s.read(".codex/hooks.json")).toContain("UserPromptSubmit");
      expect(JSON.parse(s.ok([s.forge, "instance", "show", "skill", "review", "--json"])).source).toBe("core");
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

test("T18 README stays byte-for-byte at the approved baseline", () => {
  expect(digest(join(kit, "README.md"))).toBe("0f0627b1aa3bb2b9aadbf2e4801dafb0c38be30feb9e5b89baef40be7f1be65e");
});
