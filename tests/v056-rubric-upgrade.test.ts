import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { digest, historicalKit, releaseCLI } from "./helpers/historical-kit";
import { kit, sandbox } from "./v05-sandbox";

test("0.5.5 review override keeps its body and gains the default rubric when upgraded", () => {
  const s = sandbox();
  const override = ".workbench/overrides/review";
  const resource = "references/risk-rubric.md";
  const installed = ".agents/skills/review";
  try {
    const old = join(historicalKit(s, "0.5.5"), "bin/forge");
    s.ok([old, "init", s.work]);
    const privateSkill = s.privateFile(`${override}/SKILL.md`,
      "---\nname: review\ndescription: 私有评审规则\n---\n\n# 本地评审\n\n核对发布记录。\n");
    const config = parse(s.read(".workbench/workbench.yaml"));
    s.privateFile(".workbench/workbench.yaml", stringify({...config, extensions: {...config.extensions, skills: {review: override}}}));
    s.ok([old, "sync", s.work]);
    const bytes = readFileSync(privateSkill);
    const installedSkill = join(s.work, installed, "SKILL.md");
    const installedRubric = join(s.work, installed, resource);
    const version = () => JSON.parse(s.read(".workbench/kit-lock.json")).kit_version;
    expect(version()).toBe("0.5.5");
    expect(readFileSync(installedSkill)).toEqual(bytes);
    expect(existsSync(installedRubric)).toBe(false);

    const candidate = releaseCLI(s);
    const defaultDigest = digest(join(kit, "core", installed, resource));
    for (let i = 0; i < 2; i++) {
      s.ok([candidate, "sync", s.work]);
      expect(version()).toBe("0.6.1");
      expect(readFileSync(installedSkill)).toEqual(bytes);
      expect(readFileSync(privateSkill)).toEqual(bytes);
      expect(existsSync(join(s.work, override, resource))).toBe(false);
      const review = JSON.parse(s.ok([s.forge, "instance", "show", "skill", "review", "--json"]));
      expect(review.source).toBe(realpathSync(privateSkill));
      expect(digest(join(dirname(review.value.path), resource))).toBe(defaultDigest);
      expect(JSON.parse(s.ok([s.forge, "doctor", s.work, "--json"])).ok).toBe(true);
    }
  } finally {
    s.cleanup();
    expect(existsSync(s.root)).toBe(false);
  }
}, 30_000);
