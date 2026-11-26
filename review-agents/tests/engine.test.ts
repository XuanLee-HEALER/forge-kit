import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const env = ["FORGE_CODEX_BIN", "OPENAI_BASE_URL", "OPENAI_API_KEY", "REVIEW_FIXTURE_ACTION"] as const;
  const original = env.map(k => process.env[k]);
  try {
    git("init", "-q");
    git("commit", "--allow-empty", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "SKILL.md"), "Synthetic instruction data marker");
    git("add", "--", "SKILL.md"); git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD");
    const fake = join(root, "codex");
    writeFileSync(fake, [
      "#!/usr/bin/env bun",
      'const args = process.argv.slice(2), input = JSON.parse(await Bun.stdin.text());',
      'if (!args.includes("--ephemeral") || args[args.indexOf("-s")+1] !== "read-only" || !input.diff["SKILL.md"].includes("data marker") || await Bun.file("SKILL.md").exists()) process.exit(2);',
      'if (process.env.REVIEW_FIXTURE_ACTION === "local") { console.error("HTTP 503 upstream"); process.exit(1); }',
      'if (process.env.REVIEW_FIXTURE_ACTION === "upstream") { console.log(JSON.stringify({type:"turn.failed",error:{codex_error_info:{http_connection_failed:{http_status_code:503}}}})); process.exit(1); }',
      'await Bun.write(args[args.indexOf("-o")+1], ' + JSON.stringify(JSON.stringify(raw)) + ');',
    ].join("\n")); chmodSync(fake, 0o755);
    Object.assign(process.env, { FORGE_CODEX_BIN: fake, OPENAI_API_KEY: "synthetic", OPENAI_BASE_URL: server.url.href });
    const opts = { repo: root, base, head, roles: "quality" };
    expect((await runReview({ ...opts, backend: "codex" })).status).toBe("pass");
    expect((await runReview({ ...opts, backend: "api" })).status).toBe("pass");
    expect(events[0].diff["SKILL.md"]).toContain("data marker");
    process.env.REVIEW_FIXTURE_ACTION = "upstream";
    const recovered = await runReview(opts);
    expect(recovered.roles[0].attempts.map(a => a.backend), JSON.stringify(recovered)).toEqual(["codex", "api"]);
    expect(recovered.status).toBe("pass");
    process.env.REVIEW_FIXTURE_ACTION = "local";
    expect((await runReview(opts)).status).toBe("error");
    expect(events).toHaveLength(2);
    truncated = true;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/review.ts"), "--repo", root,
      "--base", base, "--head", head, "--roles", "quality", "--backend", "api"], { env: { ...process.env }, stdout: "pipe" });
    const [reply, exitCode] = await Promise.all([new Response(child.stdout).json(), child.exited]);
    expect(exitCode).toBe(3);
    expect(reply.status).toBe("incomplete");
    expect(reply.roles[0]).toMatchObject({ status: "incomplete", findings: [], attempts: [{ backend: "api", status: "incomplete" }] });
    expect(events).toHaveLength(3);
    const incomplete = await runReview({ ...opts, roles: "business" });
    expect(incomplete.roles[0].attempts).toEqual([]);
    expect(incomplete.status).toBe("incomplete");
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
