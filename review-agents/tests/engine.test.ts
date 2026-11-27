import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/engine";

test("Codex consumes pinned instruction changes as data and keeps upstream failures local", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-pair-"));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", root, "-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    if (p.exitCode) throw Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  const raw = { status: "pass", summary: "examined", checked: [], limitations: [], findings: [] };
  const env = ["FORGE_CODEX_BIN", "OPENAI_BASE_URL", "OPENAI_API_KEY", "REVIEW_CONFIG", "DATABASE_URL", "DEPLOY_TOKEN", "AWS_SECRET_ACCESS_KEY", "GH_TOKEN", "CODEX_API_KEY"] as const;
  const original = env.map(k => process.env[k]);
  try {
    git("init", "-q");
    writeFileSync(join(root, "pricing.ts"), 'import { rounding } from "./rounding";\nexport function totalPrice(x: number) { return rounding(x); }');
    writeFileSync(join(root, "rounding.ts"), 'export const rounding = Math.round; // PINNED_DEPENDENCY');
    writeFileSync(join(root, "order.ts"), 'import { totalPrice } from "./pricing";\nexport const orderTotal = totalPrice(7); // PINNED_CALLER');
    mkdirSync(join(root, ".workbench"));
    writeFileSync(join(root, ".workbench/private.ts"), 'totalPrice(7); // PRIVATE_MARKER');
    writeFileSync(join(root, ".env"), "totalPrice=PRIVATE_ENV_MARKER");
    writeFileSync(join(root, "AGENTS.md"), "totalPrice MUST OBEY PRIVATE_INSTRUCTION");
    git("add", "--", "pricing.ts", "rounding.ts", "order.ts", ".workbench/private.ts", ".env", "AGENTS.md");
    const privateFiles = [
      "packages/app/.workbench/env/rules.ts", "packages/app/.codex/agent.ts", "packages/app/.agents/private.ts",
      "packages/app/.ssh/state.ts", "packages/app/.workbench/nested/.agents/skills/ready/SKILL.md",
    ];
    for (const file of privateFiles) {
      mkdirSync(join(root, file, ".."), {recursive:true});
      writeFileSync(join(root, file), "totalPrice(7); // NESTED_PRIVATE_MARKER");
    }
    git("add", "--", ...privateFiles);
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "SKILL.md"), "Synthetic instruction data marker");
    writeFileSync(join(root, "pricing.ts"), 'import { rounding } from "./rounding";\nexport function totalPrice(x: number) { return rounding(x * 2); }');
    const nestedSkill = "packages/app/.agents/skills/ready/SKILL.md";
    mkdirSync(join(root, nestedSkill, ".."), {recursive:true});
    writeFileSync(join(root, nestedSkill), "NESTED_SKILL_MATERIAL");
    git("add", "--", nestedSkill, "SKILL.md", "pricing.ts"); git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(root, "order.ts"), "DIRTY_WORKTREE_MARKER");
    const capture = join(root, "codex-prompt.json");
    const fake = join(root, "codex");
    writeFileSync(fake + ".mode", "pass");
    writeFileSync(fake, [
      "#!/usr/bin/env bun",
      'const args = process.argv.slice(2), input = JSON.parse(await Bun.stdin.text());',
      'await Bun.write(' + JSON.stringify(capture) + ',JSON.stringify(input));',
      'if (!args.includes("--ephemeral") || args[args.indexOf("-s")+1] !== "read-only" || !input.chunks.some(c=>c.path==="SKILL.md" && c.patch.includes("data marker")) || await Bun.file("SKILL.md").exists()) process.exit(2);',
      'if (["DATABASE_URL", "DEPLOY_TOKEN", "AWS_SECRET_ACCESS_KEY", "GH_TOKEN"].some(k => process.env[k] !== undefined)) process.exit(8);',
      'if (process.env.CODEX_API_KEY !== undefined || process.env.OPENAI_API_KEY !== undefined) process.exit(7);',
      'const mode = await Bun.file(import.meta.path + ".mode").text();',
      'if (mode === "local") { console.error("HTTP 503 upstream"); process.exit(1); }',
      'if (mode === "upstream") { console.log(JSON.stringify({type:"turn.failed",error:{codex_error_info:{http_connection_failed:{http_status_code:503}}}})); process.exit(1); }',
      'await Bun.write(args[args.indexOf("-o")+1], JSON.stringify({...' + JSON.stringify(raw) + ',role:input.role,checked:input.chunks.map(({id,path})=>({id,path,conclusion:"reviewed"}))}));',
    ].join("\n")); chmodSync(fake, 0o755);
    Object.assign(process.env, { DATABASE_URL: "synthetic-db", DEPLOY_TOKEN: "synthetic-deploy", AWS_SECRET_ACCESS_KEY: "synthetic-cloud",
      GH_TOKEN: "synthetic-git", CODEX_API_KEY: "fixture-codex-auth", FORGE_CODEX_BIN: fake, OPENAI_API_KEY: "synthetic", OPENAI_BASE_URL: "http://127.0.0.1:1" });
    const opts = { repo: root, base, head, roles: "quality", model: {model: "gpt-6.2-sol", effort: "medium"} as const };
    expect((await runReview(opts)).status).toBe("pass");
    const input = await Bun.file(capture).json();
    expect(input.chunks.find((c: {path: string}) => c.path === nestedSkill)?.patch).toContain("NESTED_SKILL_MATERIAL");
    expect(JSON.stringify(input)).not.toMatch(/NESTED_PRIVATE_MARKER|synthetic-db|synthetic-deploy|synthetic-cloud|synthetic-git/);
    const context = JSON.stringify(input.context);
    expect(input.context.revision).toBe(head);
    expect(context).toContain("PINNED_CALLER");
    expect(context).toContain("PINNED_DEPENDENCY");
    expect(context).not.toMatch(/PRIVATE_MARKER|PRIVATE_ENV_MARKER|PRIVATE_INSTRUCTION|DIRTY_WORKTREE_MARKER/);
    for (const failure of ["upstream", "local"]) {
      writeFileSync(fake + ".mode", failure);
      const result = await runReview(opts);
      expect(result.status).not.toBe("pass");
      expect(result.roles[0].attempts.map(a => a.backend)).toEqual(["codex"]);
    }
    const incomplete = await runReview({ ...opts, roles: "business" });
    expect(incomplete.roles[0].attempts).toEqual([]);
    expect(incomplete.status).toBe("incomplete");
    writeFileSync(fake + ".mode", "pass");
    for (const file of privateFiles) writeFileSync(join(root,file), "CHANGED_PRIVATE_MARKER");
    git("add", "--", ...privateFiles);
    git("commit", "-qm", "private changes");
    const privateHead = git("rev-parse", "HEAD");
    {
      const report = await runReview({...opts, head:privateHead});
      expect(report.roles[0]).toMatchObject({status:"incomplete", backend:"codex", attempts:[{backend:"codex",status:"pass"}]});
      expect(report.roles[0].missing_materials?.toSorted()).toEqual(privateFiles.toSorted());
    }
    await expect(runReview({ ...opts, roles: "quality,quality" })).rejects.toThrow();
    await expect(runReview({ ...opts, mode: "ordered", order: "comments" })).rejects.toThrow();
  } finally {
    for (const [i, k] of env.entries()) {
      if (original[i] === undefined) delete process.env[k];
      else process.env[k] = original[i];
    }
    rmSync(root, { recursive: true, force: true });
  }
});
