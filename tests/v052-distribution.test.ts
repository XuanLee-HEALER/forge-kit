import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { historicalKit } from "./helpers/historical-kit";
import { kit, sandbox } from "./v05-sandbox";

test("README preserves content outside the approved review and installation changes", () => {
  // SHA-256 of the same protected text at 0e252c19, usable in shallow offline checkouts.
  const readme = historicalReadme();
  const protectedText = readme
    .replace(/^\| \*\*L2 .*\n/m, "")
    .replace(/(?<=^- \*\*统一入口[^\n]*\n)[\s\S]*?(?=^- \*\*任务账本)/m, "")
    .replace(/^```mermaid\n[\s\S]*?^```\n/m, "")
    .replace(/(?<=^#### 3\. 四维独立 Review\n)[\s\S]*?(?=\n#### 4\.)/m, "");
  expect(createHash("sha256").update(protectedText).digest("hex")).toBe("99f92e226a0a6fb25eb18d61ebdea266018bbcad60a319fceeacaabb27db22ba");
  expect(readme).toContain("forge ledger review-record");
});

test("T12 README changes only the approved v0.5.7 delivery sentence", () => {
  const readme = historicalReadme();
  const approved = "交付前，至少有一个角色沿提交链无空洞覆盖任务基线至交付 HEAD，且所有已启动角色均无未解除的评审失败";
  const previous = "交付 HEAD 至少有一份从任务基线审起的通过报告";
  expect(readme.split("\n")[100]).toContain(approved);
  // Hash of the entire README at fec8d0b, including its final newline.
  expect(createHash("sha256").update(readme.replace(approved, previous)).digest("hex"))
    .toBe("1732e1bcfbbb0837019e367fcf5a0c142abce11b50e0a0e311b36dd306bee8a4");
});

function historicalReadme() {
  const s = sandbox();
  try {
    return readFileSync(join(historicalKit(s, "0.6.0"), "README.md"), "utf8");
  } finally { s.cleanup(); }
}

test("current distribution removes stale JS bundles and retired protocol configuration", () => {
  const temp = mkdtempSync(join(tmpdir(), "forge-dist-contract-"));
  try {
    // Build a private copy so a failed or interrupted check cannot alter a developer's dist.
    for (const part of ["package.json", "src", "scripts"]) {
      cpSync(join(kit, part), join(temp, part), {
        recursive: true, filter: path => !/(?:^|\/)(node_modules|dist)(?:\/|$)/.test(path),
      });
    }
    symlinkSync(join(kit, "node_modules"), join(temp, "node_modules"));
    const manifest = JSON.parse(readFileSync(join(temp, "package.json"), "utf8"));
    expect(manifest.version).toBe("0.6.3");
    expect(JSON.stringify(manifest)).not.toContain("review-agents");
    expect(readFileSync(join(kit, "kit.toml"), "utf8")).toMatch(/^version = "0\.6\.3"$/m);
    mkdirSync(join(temp, "dist"));
    writeFileSync(join(temp, "dist/stale.js"), "stale");
    const result = Bun.spawnSync([process.execPath, "run", "build"], { cwd: temp });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readdirSync(join(temp, "dist"))).toEqual(["cli.js"]);
    const out = Bun.spawnSync([process.execPath, join(temp, "dist/cli.js"), "--help"], {cwd: temp});
    expect(out.exitCode, out.stderr.toString()).toBe(0);
    for (const path of ["core/AGENTS.md", "core/.agents/skills/ship/SKILL.md", "templates/workbench.yaml"]) {
      const source = readFileSync(join(kit, path), "utf8");
      expect(source).not.toMatch(/atomic_pr_hosts|forge\.atomic-pr\.v1|forge\/atomic-pr\/v1/);
    }
    for (const path of new Bun.Glob("**/*").scanSync({ cwd: join(kit, "core"), dot: true, onlyFiles: true })) {
      expect(readFileSync(join(kit, "core", path), "utf8"), path).not.toMatch(/\bFAT\b|\bHurl\b/i);
    }
    expect(readFileSync(join(temp, "dist/cli.js"), "utf8")).not.toMatch(/forge\.atomic-pr\.v1|forge\/atomic-pr\/v1/);
    for (const path of ["review-agents/package.json", "review-agents/src", "src/forge-review.ts", "src/ledger/review-fallback.ts"]) {
      expect(existsSync(join(kit, path)), path).toBe(false);
    }
    expect(readFileSync(join(kit, "core/AGENTS.md")).length).toBeLessThan(8000);
    const guard = join(kit, "src/guard");
    const lines = readdirSync(guard).filter(f => f.endsWith(".ts")).reduce((n, f) => n + (readFileSync(join(guard, f), "utf8").match(/\n/g)?.length ?? 0), 0);
    expect(lines).toBeLessThanOrEqual(750);
    for (const obsolete of ["docs/designs", "docs", "packs"]) expect(existsSync(join(kit, obsolete))).toBe(false);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}, 30_000);

test("effective skills and read-only reviewer roles can load the installed review rubric", () => {
  const s = sandbox();
  const resource = "references/risk-rubric.md";
  const installed = `.agents/skills/review/${resource}`;
  try {
    s.fresh();
    const skill = (id: string) => JSON.parse(s.ok([s.forge, "instance", "show", "skill", id, "--json"]));
    const review = skill("review");
    const referencePath = join(dirname(review.value.path), resource);
    expect(review.source).toBe("core");
    expect(review.value.body).toContain(`](${resource})`);
    const guidance: string = review.value.body;
    expect(guidance).toMatch(/forge ledger reviews[\s\S]+spawn_agent[\s\S]+fork_turns="none"/);
    expect(guidance).toMatch(/仅续聊受影响角色[^\n]*followup_task[^\n]*原会话 ID/);
    expect(guidance).toMatch(/原会话不可续聊或规格 amend[^\n]*新开会话全审/);
    expect(guidance).toMatch(/incomplete[^\n]*原会话扩大范围[^\n]*缺证区间/);
    const core = readFileSync(referencePath, "utf8");
    expect(core).toBe(readFileSync(join(kit, "core", installed), "utf8"));
    for (const id of ["grill", "feature", "pr-triage"]) expect(skill(id).value.body).toContain(installed);
    for (const role of ["business", "quality", "simplify", "comments"]) {
      const values = Bun.TOML.parse(s.read(`.codex/agents/reviewer-${role}.toml`)) as {developer_instructions: string};
      expect(values).toMatchObject({name: `reviewer-${role}`, sandbox_mode: "read-only"});
      expect(values.developer_instructions).toContain(installed);
      const habits = values.developer_instructions.split("\n").filter(line => line.includes("git diff --stat"));
      expect(habits).toHaveLength(1);
      expect(habits[0]).toMatch(/git diff --stat.*按文件.*上下文.*新改动.*已审代码.*交互/);
    }

    const privateDir = ".workbench/overrides/review";
    const body = "---\nname: review\ndescription: Site review guidance\n---\n[Site rubric](references/risk-rubric.md)\n";
    const privateSkill = s.privateFile(`${privateDir}/SKILL.md`, body);
    s.privateFile(`${privateDir}/${resource}`, "Site review rubric.\n");
    const config = parse(s.read(".workbench/workbench.yaml"));
    s.privateFile(".workbench/workbench.yaml", stringify({...config, extensions: {...config.extensions, skills: {review: privateDir}}}));
    const sync = [s.forge, "sync", s.work];
    for (let i = 0; i < 2; i++) {
      s.ok(sync);
      const local = skill("review");
      expect(local.source).toBe(realpathSync(privateSkill));
      expect(local.value.description).toBe("Site review guidance");
      expect(readFileSync(join(dirname(local.value.path), resource), "utf8")).toBe("Site review rubric.\n");
      expect(s.read(installed)).toBe("Site review rubric.\n");
      expect(s.read(`${privateDir}/SKILL.md`)).toBe(body);
    }
  } finally {
    s.cleanup();
    expect(existsSync(s.root)).toBe(false);
  }
}, 30_000);
