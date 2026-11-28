import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { auditFixture } from "./helpers/audit-cli";
import { historicalKit, releaseCLI } from "./helpers/historical-kit";
import { snapshot } from "./helpers/ledger-snapshot";
import { kit, sandbox } from "./v05-sandbox";

for (const version of ["0.5.7", "0.6.2"] as const) test(`S01/V01 v${version} sync discovers triage and retains old instances and history`, () => {
  const s = sandbox();
  try {
    const historical = historicalKit(s, version);
    const old = join(historical, "bin/forge");
    s.ok([old, "init", s.work]);
    const lock = () => JSON.parse(s.read(".workbench/kit-lock.json")).kit_version;
    expect(lock()).toBe(version);
    s.git(s.work, "init", "-b", "main");
    s.git(s.work, "config", "user.name", "Upgrade Fixture");
    s.git(s.work, "config", "user.email", "fixture@example.invalid");
    s.privateFile("seed.txt", "local Git baseline\n");
    s.git(s.work, "add", "--", "seed.txt");
    s.git(s.work, "commit", "-m", "Local Git baseline");
    const sha = s.git(s.work, "rev-parse", "HEAD").trim();
    s.ok([old, "add-repo", s.work, "--workbench", s.work]);

    const config = ".workbench/workbench.yaml";
    const originalConfig = s.read(config);
    const priorCfg = parse(originalConfig);
    expect(priorCfg.extensions?.runtime).toBeUndefined();
    const custom = ".workbench/custom/triage";
    const privateText = "---\nname: triage\ndescription: Private triage fixture\n---\n\nRead private fixture logs.\n";
    const privateSkill = s.privateFile(custom + "/SKILL.md", privateText);
    const privateFiles = [
      "AGENTS.local.md", ".workbench/root-repo.md", ".workbench/models.toml",
    ];
    for (const path of privateFiles) s.privateFile(path, s.read(path) + "\n# Authored fixture " + path + "\n");
    const saved = privateFiles.map(path => [path, s.read(path)] as const);
    const f = auditFixture(s);
    f.open("existing", ["--repo", ".", "--branch", "main"]);
    const originalTip = f.call("tip", "existing");
    const originalStatus = f.status("existing");
    const originalLedger = snapshot(s.work);
    const installed = releaseCLI(s);
    const run = (...args: string[]) => s.ok([s.forge, ...args]);
    const sync = () => s.ok([installed, "sync", s.work]);
    const skill = () => JSON.parse(run("instance", "show", "skill", "triage", "--json"));
    const triagePath = ".agents/skills/triage/SKILL.md";
    const core = readFileSync(join(kit, "core", triagePath), "utf8");
    expect(core.trimEnd().split("\n").length).toBeLessThanOrEqual(25);
    const body = core.split(/\n---\n/)[1].trim();

    for (let i = 0; i < 2; i++) {
      sync();
      expect(lock()).toBe("0.6.3");
      expect(s.read(config)).toBe(originalConfig);
      for (const [path, bytes] of saved) expect(s.read(path)).toBe(bytes);
      expect(f.status("existing")).toEqual(originalStatus);
      expect(f.call("tip", "existing")).toBe(originalTip);
      expect(f.json("verify", "--task", "existing", "--json").ok).toBe(true);
      expect(snapshot(s.work)).toEqual(originalLedger);
      expect(skill()).toMatchObject({source: "core"});
      expect(skill().value.body.trim()).toBe(body);
      expect(s.read(triagePath)).toBe(core);
      const entries = JSON.parse(run("instance", "list", "--json"));
      expect(entries).toContainEqual(expect.objectContaining({kind: "skill", id: "triage", source: "core"}));
      const runtime = JSON.parse(run("rt", "list", "--json"));
      expect(runtime.ok).toBe(true);
      expect(runtime.data.map((row: {primitive: string}) => row.primitive))
        .toEqual(["status", "changes", "logs", "query", "metrics"]);
      expect(runtime.data.filter((row: {status: string}) => row.status === "unconfigured")).toHaveLength(4);
      const changes = JSON.parse(run("rt", "changes", "--json"));
      expect(changes.data).toMatchObject({ repo: ".", git: { to_sha: sha } });
    }

    s.privateFile(config, stringify({ ...priorCfg, extensions: { ...priorCfg.extensions, skills: { triage: custom } } }));
    sync();
    sync();
    expect(skill().source).not.toBe("core");
    expect(skill().value.body.trim()).toBe("Read private fixture logs.");
    expect(s.read(triagePath)).toContain("Read private fixture logs.");
    s.privateFile(config, originalConfig);
    sync();
    expect(skill().source).toBe("core");
    expect(s.read(triagePath)).toBe(core);
    expect(readFileSync(privateSkill, "utf8")).toBe(privateText);

    if (version === "0.6.2") {
      const bugfix = ".agents/skills/bugfix/SKILL.md";
      const before = readFileSync(join(historical, "core", bugfix), "utf8").split("\n");
      const after = readFileSync(join(kit, "core", bugfix), "utf8").split("\n");
      expect(after).toHaveLength(before.length);
      const changed = before.flatMap((line, index) => line === after[index] ? [] : [index]);
      expect(changed).toHaveLength(1);
      expect(before[changed[0]]).toMatch(/只读诊断|read.only diagnosis/i);
      expect(after[changed[0]]).toMatch(/只读诊断|read.only diagnosis/i);
    }
  } finally {
    s.cleanup();
    expect(existsSync(s.root)).toBe(false);
  }
}, 65_000);

test("S02 triage instructions name the evidence workflow, outcome and handoff", () => {
  const triage = readFileSync(join(kit, "core/.agents/skills/triage/SKILL.md"), "utf8");
  const window = triage.search(/时间窗|time window/i);
  const discovery = triage.indexOf("rt list");
  expect(window).toBeGreaterThanOrEqual(0);
  expect(discovery).toBeGreaterThan(window);
  for (const meaning of [
    /环境|environment/i, /对象|object|target/i, /保证|保障|guarantee/i, /只读|read.only/i, /可证伪|falsif/i,
    /原语|primitive/i, /代码|code/i, /现象|symptom/i, /证据|evidence/i, /判定|assessment/i,
    /影响面|影响范围|impact/i, /下一步|next step/i, /数据问题|data issue/i, /配置问题|configuration issue/i,
    /代码 (bug|缺陷)|代码缺陷|code bug/i, /证据不足|insufficient evidence/i, /根因|root cause/i, /bugfix/,
    /写入|修改线上数据|write/i, /配置|config/i, /重启|restart/i, /操作人|操作者|operator|ship/i,
  ]) expect(triage).toMatch(meaning);
});
