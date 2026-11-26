import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { kit, sandbox } from "./v05-sandbox";

// Run independently of the Bun unit suite. Only this integration path needs the Hurl executable.
const hurl = Bun.which("hurl");
if (!hurl) throw new Error("Install Hurl to run this loopback integration check.");
const s = sandbox();
let server: ReturnType<typeof Bun.serve> | undefined;
let port: number | undefined;
try {
  s.fresh();
  const repo = join(s.work, "service");
  mkdirSync(repo);
  s.git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "response.json"), JSON.stringify({healthy: true}));
  s.git(repo, "add", "--", "response.json");
  s.git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture", "--", "response.json");
  const revision = s.git(repo, "rev-parse", "HEAD").trim();
  const requests: string[] = [];
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname);
      return Response.json({commit: s.git(repo, "rev-parse", "HEAD").trim()});
    },
  });
  port = server.port!;
  const path = join(s.work, ".workbench/workbench.yaml");
  const config = parse(readFileSync(path, "utf8"));
  async function verify(expected: string) {
    const argv = [hurl!, "--test", "--variable", "service=" + server!.url.origin, "--variable", "revision=" + expected,
      join(kit, "tests/v05-version.hurl")];
    writeFileSync(path, stringify({...config, extensions: { actions: {version: {purpose: "verify", cwd: ".", argv}},
      stages: {isolation: {action: "version"}}, verification: {environment: "isolated", stages: ["isolation"]} }}));
    const proc = Bun.spawn([s.forge, "instance", "run", "isolation"], {
      cwd: s.work, env: s.env, stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return {code, text: out + err};
  }
  const ok = await verify(revision);
  assert.equal(ok.code, 0, ok.text);
  const stale = await verify("0".repeat(40));
  assert.notEqual(stale.code, 0, stale.text);
  assert.deepEqual(requests, ["/version", "/version"]);
  console.log(JSON.stringify({revision, valid: ok.code, stale: stale.code, httpRequests: requests.length}));
} finally {
  await server?.stop(true);
  s.cleanup();
  assert.equal(existsSync(s.root), false);
  if (port) {
    const freed = Bun.serve({hostname: "127.0.0.1", port, fetch: () => new Response()});
    await freed.stop(true);
  }
}
