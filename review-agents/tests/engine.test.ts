import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview } from "../src/engine";

test("both adapters consume pinned instruction changes as data; only a trusted upstream error falls back", async () => {
  const root = mkdtempSync(join(tmpdir(), "review-pair-"));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", root, "-c", "user.name=Fixture", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args]);
    if (p.exitCode) throw Error(p.stderr.toString());
    return p.stdout.toString().trim();
  };
  const events: any[] = [];
  let truncated = false;
  const raw = { status: "pass", summary: "examined", checked: [], limitations: [], findings: [] };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer synthetic");
      const body = await request.json();
      events.push(JSON.parse(body.input));
      if (truncated) return Response.json({ id: "resp_partial", object: "response", status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" }, output: [
          { type: "message", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: '{"status":"pass"' }] },
        ] });
      return Response.json({ id: "resp_test", object: "response", status: "completed", output: [
        { id: "msg_test", type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(raw) }] },
      ] });
    },
  });
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
      'if (!args.includes("--ephemeral") || args[args.indexOf("-s")+1] !== "read-only" || !input.diff["SKILL.md"].includes("data marker") || await Bun.file("SKILL.md").exists()) process.exit(2);',
      'if (["DATABASE_URL", "DEPLOY_TOKEN", "AWS_SECRET_ACCESS_KEY", "GH_TOKEN"].some(k => process.env[k] !== undefined)) process.exit(8);',
      'if (process.env.CODEX_API_KEY !== "fixture-codex-auth") process.exit(7);',
      'const mode = await Bun.file(import.meta.path + ".mode").text();',
      'if (mode === "local") { console.error("HTTP 503 upstream"); process.exit(1); }',
      'if (mode === "upstream") { console.log(JSON.stringify({type:"turn.failed",error:{codex_error_info:{http_connection_failed:{http_status_code:503}}}})); process.exit(1); }',
      'await Bun.write(args[args.indexOf("-o")+1], ' + JSON.stringify(JSON.stringify(raw)) + ');',
    ].join("\n")); chmodSync(fake, 0o755);
    Object.assign(process.env, { DATABASE_URL: "synthetic-db", DEPLOY_TOKEN: "synthetic-deploy", AWS_SECRET_ACCESS_KEY: "synthetic-cloud",
      GH_TOKEN: "synthetic-git", CODEX_API_KEY: "fixture-codex-auth", FORGE_CODEX_BIN: fake, OPENAI_API_KEY: "synthetic", OPENAI_BASE_URL: server.url.href });
    const opts = { repo: root, base, head, roles: "quality" };
    expect((await runReview({ ...opts, backend: "codex" })).status).toBe("pass");
    expect((await runReview({ ...opts, backend: "api" })).status).toBe("pass");
    expect(events[0].diff["SKILL.md"]).toContain("data marker");
    expect(await Bun.file(capture).json()).toEqual(events[0]);
    expect(events[0].diff[nestedSkill]).toContain("NESTED_SKILL_MATERIAL");
    expect(JSON.stringify(events[0])).not.toMatch(/NESTED_PRIVATE_MARKER|synthetic-db|synthetic-deploy|synthetic-cloud|synthetic-git/);
    const context = JSON.stringify(events[0].context);
    expect(events[0].context.revision).toBe(head);
    expect(context).toContain("PINNED_CALLER");
    expect(context).toContain("PINNED_DEPENDENCY");
    expect(context).not.toMatch(/PRIVATE_MARKER|PRIVATE_ENV_MARKER|PRIVATE_INSTRUCTION|DIRTY_WORKTREE_MARKER/);
    writeFileSync(fake + ".mode", "upstream");
    const recovered = await runReview(opts);
    expect(recovered.roles[0].attempts.map(a => a.backend), JSON.stringify(recovered)).toEqual(["codex", "api"]);
    expect(recovered.status).toBe("pass");
    writeFileSync(fake + ".mode", "local");
    expect((await runReview(opts)).status).toBe("error");
    expect(events).toHaveLength(2);
    truncated = true;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/review.ts"), "--repo", root,
      "--base", base, "--head", head, "--roles", "quality", "--backend", "api"], { env: { ...process.env }, stdout: "pipe" });
    const [reply, exitCode] = await Promise.all([new Response(child.stdout).json(), child.exited]);
    expect(exitCode).toBe(3);
    expect(reply.status).toBe("incomplete");
    expect(reply.roles[0]).toMatchObject({ status: "incomplete", findings: [], limitations: ["API response incomplete: max_output_tokens"], attempts: [{ backend: "api", status: "incomplete" }] });
    expect(events).toHaveLength(3);
    const incomplete = await runReview({ ...opts, roles: "business" });
    expect(incomplete.roles[0].attempts).toEqual([]);
    expect(incomplete.status).toBe("incomplete");
    const config = join(root, "credential-fixture.toml");
    writeFileSync(config, 'openai = [SYNTHETIC_PARSER_SECRET');
    delete process.env.OPENAI_API_KEY;
    process.env.REVIEW_CONFIG = config;
    const malformed = await runReview({...opts, backend:"api"});
    expect(malformed.roles[0].summary).toContain("Cannot read or parse credential TOML");
    expect(JSON.stringify(malformed)).not.toContain("SYNTHETIC_PARSER_SECRET");
    for (const file of privateFiles) writeFileSync(join(root,file), "CHANGED_PRIVATE_MARKER");
    git("add", "--", ...privateFiles);
    git("commit", "-qm", "private changes");
    const privateHead = git("rev-parse", "HEAD");
    for (const backend of ["api", "codex"] as const) {
      const report = await runReview({...opts, head:privateHead, backend});
      expect(report.roles[0]).toMatchObject({status:"incomplete", backend:null, attempts:[]});
      expect(report.roles[0].missing_materials?.toSorted()).toEqual(privateFiles.toSorted());
    }
    expect(events).toHaveLength(3);
    await expect(runReview({ ...opts, roles: "quality,quality" })).rejects.toThrow();
    await expect(runReview({ ...opts, mode: "ordered", order: "comments" })).rejects.toThrow();
  } finally {
    for (const [i, k] of env.entries()) {
      if (original[i] === undefined) delete process.env[k];
      else process.env[k] = original[i];
    }
    server.stop(true); rmSync(root, { recursive: true, force: true });
  }
});
