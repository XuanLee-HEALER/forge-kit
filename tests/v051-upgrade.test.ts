import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { bootstrap, kit, sandbox } from "./v05-sandbox";

const baseline = "e2d7453ab08bee29cf174425e84012819a74bcc3";
const archiveDigest = "dd59b1771a3e19e9b588dd3b46d21a714c79b6226e848f55539664c81ece80eb";
const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

test("sync from v0.5 twice preserves private verification actions, decisions and run history", () => {
  const s = sandbox();
  try {
    const old = join(s.root, "v05");
    const tar = join(s.root, "baseline.tar");
    mkdirSync(old);
    const supplied = process.env.FORGE_V05_TEST_ARCHIVE;
    if (supplied !== undefined) copyFileSync(supplied, tar);
    else s.ok(["git", "-C", kit, "--no-replace-objects", "-c", "core.attributesFile=/dev/null", "-c", "tar.umask=0002",
      "archive", "--format=tar", "--output", tar, baseline]);
    expect(digest(tar)).toBe(archiveDigest);
    s.ok(["tar", "-xf", tar, "-C", old]);
    symlinkSync(join(kit, "node_modules"), join(old, "node_modules"));
    symlinkSync(join(kit, "review-agents/node_modules"), join(old, "review-agents/node_modules"));
    const oldCLI = join(old, "bin/forge");
    s.ok([oldCLI, "init", s.work]);
    const lockVersion = () => JSON.parse(s.read(".workbench/kit-lock.json")).kit_version;
    expect(lockVersion()).toBe("0.5.0");

    const app = join(s.work, "app");
    const script = s.privateFile("app/check.ts", 'console.log("local contract executed");\n');
    s.git(app, "init", "-b", "development");
    s.git(app, "add", "--", "check.ts");
    s.git(app, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "check", "--", "check.ts");
    const head = s.git(app, "rev-parse", "HEAD").trim();
    const config = join(s.work, ".workbench/workbench.yaml");
    // This upgrade exercises action discovery. The Web tool is installed but must never run in the local stage.
    writeFileSync(join(s.bin, "hurl"), "#!/bin/sh\nexit 97\n", {mode: 0o755});
    const webAction = {purpose: "verify", cwd: ".", argv: ["hurl", "--test", "api.hurl"]};
    writeFileSync(config, stringify({...parse(s.read(".workbench/workbench.yaml")), repos: ["app"], extensions: {
      actions: { local: {purpose: "verify", cwd: ".", argv: ["bun", "check.ts"]}, web: webAction },
      stages: {localCheck: {action: "local"}, webCheck: {action: "web"}},
      verification: {environment: "isolated", stages: ["localCheck"]},
    }}));
    const local = s.privateFile("AGENTS.local.md", "Private upgrade marker\n");
    const scope = s.privateFile(".workbench/specs/history/scope.md", "Record a non-Web project check.\n");
    const files = [local, scope, config, script];
    const before = files.map(digest);
    const ledger = (...args: string[]) => s.ok([s.forge, "ledger", ...args]);
    ledger("open", "--id", "history", "--title", "Upgrade witness", "--repo", "app", "--branch", "development",
      "--worktree", app, "--base", head, "--head", head, "--endpoint", "local", "--depth", "targeted");
    ledger("decide", "history", "--key", "contract", "--summary", "Run the local project check on this revision");
    ledger("freeze", "history", "--lock-tests", "check.ts");
    const verify = [s.forge, "verify", "--task", "history", "--cwd", app, "--mode", "all"];
    expect(JSON.parse(s.ok(verify))).toMatchObject({ok: true, head});
    const snapshot = () => ({
      status: JSON.parse(ledger("status", "--task", "history", "--json")),
      decision: JSON.parse(ledger("query", "--q", "contract", "--json")),
      verify: JSON.parse(ledger("query", "--q", "verify", "--repo", "app", "--json")),
      tip: ledger("tip", "history"),
    });
    const initial = snapshot();
    expect(initial.decision.events.some((event: {payload_json: string}) =>
      JSON.parse(event.payload_json).summary === "Run the local project check on this revision")).toBe(true);
    expect(initial.verify.events.some((event: {task_id: string; sha: string; payload_json: string}) =>
      event.task_id === "history" && event.sha === head && JSON.parse(event.payload_json).status === "pass")).toBe(true);

    for (let i = 0; i < 2; i++) {
      s.ok([bootstrap, "sync", s.work]);
      expect(lockVersion()).toBe("0.5.1");
      expect(files.map(digest)).toEqual(before);
      expect(snapshot()).toEqual(initial);
      expect(JSON.parse(s.ok([s.forge, "instance", "show", "action", "web", "--json"])).value).toMatchObject(webAction);
      expect(JSON.parse(s.ok([s.forge, "doctor", s.work, "--json"])).ok).toBe(true);
      expect(JSON.parse(ledger("verify", "--task", "history", "--json")).ok).toBe(true);
    }
  } finally {
    s.cleanup();
    expect(existsSync(s.root)).toBe(false);
  }
}, 90_000);
