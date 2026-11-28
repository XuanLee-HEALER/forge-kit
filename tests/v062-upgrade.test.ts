import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { auditFixture, message, tokenCount, tokens } from "./helpers/audit-cli";
import { historicalKit, releaseCLI } from "./helpers/historical-kit";
import { kit, sandbox } from "./v05-sandbox";

test("A12/C02 actual v0.6.1 installation keeps existing cards, private files and ledger across two syncs", () => {
  const s = sandbox();
  try {
    const old = join(historicalKit(s, "0.6.1"), "bin/forge");
    s.ok([old, "init", s.work]);
    const kitVersion = () => JSON.parse(s.read(".workbench/kit-lock.json")).kit_version;
    expect(kitVersion()).toBe("0.6.1");
    for (const name of [".", "indexed"]) {
      const cwd = join(s.work, name);
      s.privateFile(join(name, "package.json"), '{"name":"upgrade-fixture"}');
      s.git(cwd, "init", "-b", "main");
      s.ok([old, "add-repo", cwd, "--workbench", s.work]);
    }

    const rootCard = ".workbench/root-repo.md";
    const indexCard = ".workbench/repos/indexed.md";
    expect(s.read(indexCard)).toContain("## Domain Index");
    s.privateFile(rootCard, s.read(rootCard).replace(/\n## Domain Index[\s\S]*$/, "\n") + "\nRoot author marker.\n");
    s.privateFile(indexCard, s.read(indexCard) + "\nIndexed author marker.\n");
    s.privateFile("AGENTS.local.md", s.read("AGENTS.local.md") + "\nLocal author marker.\n");
    s.privateFile(".workbench/private-v062-marker.txt", "private fixture bytes\n");
    const saved = [rootCard, indexCard, "AGENTS.local.md", ".workbench/private-v062-marker.txt"]
      .map(path => [path, readFileSync(join(s.work, path))] as const);

    const f = auditFixture(s);
    f.open("v061-history", ["--session-id", "v061-history"]);
    f.put("v061-history", [message(1, "user", "legacy v0.6.1 fixture"), tokenCount(2, tokens(10, 2, 1, 5, 1))]);
    f.json("close", "v061-history");
    const archive = f.path("v061-history", "summary.json");
    const oldSummary = readFileSync(archive);
    const oldStatus = f.status("v061-history");
    const oldCost = f.json("cost", "v061-history", "--json");
    const oldTip = f.call("tip", "v061-history");
    expect(oldCost.usage.total_tokens).toBe(15);
    expect(f.json("verify", "--task", "v061-history").ok).toBe(true);

    const candidate = releaseCLI(s);
    const source = readFileSync(join(kit, "core/.agents/skills/apply/SKILL.md"), "utf8");
    const [, frontMatter, ...bodyParts] = source.split("---\n");
    const coreSkill = parse(frontMatter) as { description: string };
    const skillBody = bodyParts.join("---\n");
    for (let pass = 1; pass <= 2; pass++) {
      const sync = s.run([candidate, "sync", s.work]);
      expect(sync.code, `sync ${pass}: ${sync.out}\n${sync.err}`).toBe(0);
      expect(kitVersion()).toBe("0.6.2");
      const skill = JSON.parse(s.ok([s.forge, "instance", "show", "skill", "apply", "--json"]));
      expect(skill.source).toBe("core");
      expect(skill.value.description).toBe(coreSkill.description);
      expect(skill.value.body.trim()).toBe(skillBody.trim());
      const lines = skill.value.body.trim().split("\n").length;
      expect(lines).toBeGreaterThanOrEqual(45);
      expect(lines).toBeLessThanOrEqual(65);
      for (const [path, bytes] of saved) expect(readFileSync(join(s.work, path)), path).toEqual(bytes);
      expect(readFileSync(archive)).toEqual(oldSummary);
      expect(f.status("v061-history")).toEqual(oldStatus);
      expect(f.call("tip", "v061-history")).toBe(oldTip);
      expect(f.json("verify", "--task", "v061-history").ok).toBe(true);
      expect(f.json("cost", "v061-history", "--json").usage).toEqual(oldCost.usage);
      console.log(`A12/C02 source=0.6.1 sync=${pass} exit=${sync.code} kit=${kitVersion()} summary_tokens=15 chain=verified`);
    }

    const newRepo = join(s.work, "fresh-card");
    s.privateFile("fresh-card/go.mod", "module example.invalid/fresh-card\n");
    s.git(newRepo, "init", "-b", "main");
    s.ok([s.forge, "add-repo", newRepo, "--workbench", s.work]);
    const card = s.read(".workbench/repos/fresh-card.md");
    for (const heading of [
      /技术栈|stack/i, /命令|commands/i, /风格|style/i, /\bCI\b/i, /分支|branch/i,
      /禁区|forbidden/i, /历史|legacy/i, /旧范式|legacy/i, /^## Domain Index$/m,
    ]) expect(card).toMatch(heading);
    expect(card.trimEnd().split("\n").length).toBeLessThanOrEqual(120);
  } finally {
    s.cleanup();
    expect(existsSync(s.root)).toBe(false);
  }
}, 60_000);
