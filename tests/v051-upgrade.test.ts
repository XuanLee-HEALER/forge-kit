import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { sandbox } from "./v05-sandbox";

import { releaseCLI, digest, historicalKit, type HistoricalVersion } from "./helpers/historical-kit";
import { snapshot as ledgerSnapshot } from "./helpers/ledger-snapshot";

for (const version of ["0.5.0", "0.5.1", "0.5.2", "0.5.3"] satisfies HistoricalVersion[]) test(
  `sync twice from ${version} preserves historical rows, tips, private files and actions`, () => {
  const s = sandbox();
  try {
    const bootstrap = releaseCLI(s);
    const old = historicalKit(s, version);
    const oldCLI = join(old, "bin/forge");
    s.ok([oldCLI, "init", s.work]);
    const lockVersion = () => JSON.parse(s.read(".workbench/kit-lock.json")).kit_version;
    expect(lockVersion()).toBe(version);

    const app = join(s.work, "app");
    const script = s.privateFile("app/check.ts", 'console.log("local contract executed");\n');
    s.privateFile("app/api.hurl", "GET http://127.0.0.1/health\nHTTP 200\n");
    s.git(app, "init", "-b", "development");
    s.git(app, "add", "--", "check.ts", "api.hurl");
    s.git(app, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "check", "--", "check.ts", "api.hurl");
    const head = s.git(app, "rev-parse", "HEAD").trim();
    const ready = s.privateFile(".workbench/overrides/ready/SKILL.md", "---\nname: ready\ndescription: Site ready check\n---\nUse the site runbook.\n");
    const card = s.privateFile(".workbench/repos/app.md", "# app\nPrivate project conventions.\n");
    const artifact = s.privateFile(".workbench/runs/history/evidence.log", "Observed check output.\n");
    const config = join(s.work, ".workbench/workbench.yaml");
    // This upgrade exercises action discovery. The Web tool is installed but must never run in the local stage.
    writeFileSync(join(s.bin, "hurl"), "#!/bin/sh\nexit 97\n", {mode: 0o755});
    const webAction = {purpose: "verify", cwd: ".", argv: ["hurl", "--test", "api.hurl"]};
    writeFileSync(config, stringify({...parse(s.read(".workbench/workbench.yaml")), repos: ["app"], extensions: {
      skills: { ready: ".workbench/overrides/ready" },
      actions: { local: {purpose: "verify", cwd: ".", argv: ["bun", "check.ts"]}, web: webAction },
      stages: {localCheck: {action: "local"}, webCheck: {action: "web"}},
      verification: {environment: "isolated", stages: ["localCheck"]},
    }}));
    s.ok([oldCLI, "sync", s.work]);
    const show = (kind: string, id: string) => JSON.parse(s.ok([s.forge, "instance", "show", kind, id, "--json"]));
    const privateReady = show("skill", "ready");
    const privateAction = show("action", "web");
    expect(privateReady.value.description).toBe("Site ready check");
    const local = s.privateFile("AGENTS.local.md", "Private upgrade marker\n");
    const scope = s.privateFile(".workbench/specs/history/scope.md", "Record a non-Web project check.\n");
    const policy = join(s.work, ".workbench/ship-policy.yaml");
    expect(parse(readFileSync(policy, "utf8")).fast_track.forbid_db_rw).toBe(version === "0.5.2" || version === "0.5.3");
    const files = [ready, card, artifact, local, scope, config, script, policy, join(s.work, ".workbench/models.toml")];
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
    const rows = ledgerSnapshot(s.work);
    expect(initial.decision.events.some((event: {payload_json: string}) =>
      JSON.parse(event.payload_json).summary === "Run the local project check on this revision")).toBe(true);
    expect(initial.verify.events.some((event: {task_id: string; sha: string; payload_json: string}) =>
      event.task_id === "history" && event.sha === head && JSON.parse(event.payload_json).status === "pass")).toBe(true);

    if (version === "0.5.3") {
      const managed = join(s.work, ".codex/config.toml");
      const stock = readFileSync(managed, "utf8");
      const changed = stock + "# operator adjustment\n";
      writeFileSync(managed, changed);
      const conflict = (cli: string) => {
        const result = s.run([cli, "sync", s.work]);
        expect(result.code).not.toBe(0);
        expect(result.err + result.out).toContain("Ownership conflict at " + realpathSync(managed));
        expect(readFileSync(managed, "utf8")).toBe(changed);
        expect(lockVersion()).toBe(version);
        expect(ledgerSnapshot(s.work, rows.schema)).toEqual(rows);
        return result.code;
      };
      const baselineExit = conflict(oldCLI);
      expect(conflict(bootstrap)).toBe(baselineExit);
      writeFileSync(managed, stock);
    }
    for (let i = 0; i < 2; i++) {
      s.ok([bootstrap, "sync", s.work]);
      expect(lockVersion()).toBe("0.5.4");
      expect(ledgerSnapshot(s.work, rows.schema)).toEqual(rows);
      expect(show("skill", "ready")).toEqual(privateReady);
      expect(show("action", "web")).toEqual(privateAction);
      expect(files.map(digest)).toEqual(before);
      expect(snapshot()).toEqual(initial);
      expect(JSON.parse(s.ok([s.forge, "instance", "show", "action", "web", "--json"])).value).toMatchObject(webAction);
      expect(JSON.parse(s.ok([s.forge, "doctor", s.work, "--json"])).ok).toBe(true);
      expect(JSON.parse(ledger("verify", "--task", "history", "--json")).ok).toBe(true);
    }
    const events = () => ledgerSnapshot(s.work, rows.schema).rows[rows.schema.findIndex(table => table.name === "events")];
    const original = events();
    ledger("decide", "history", "--key", "continuation", "--summary", "Recorded after upgrading");
    const updated = events();
    expect(updated.slice(0, original.length)).toEqual(original);
    const event = JSON.parse(ledger("query", "--q", "continuation", "--json")).events.at(-1);
    expect(JSON.parse(event.payload_json).summary).toBe("Recorded after upgrading");
    expect(event.prev_hash).toBe(initial.tip.trim().split("@").at(-1));
    expect(JSON.parse(ledger("verify", "--task", "history", "--json")).ok).toBe(true);
    if (version === "0.5.3") {
      const calls = join(s.root, "hurl.json");
      const hurl = join(s.bin, "hurl");
      writeFileSync(hurl, `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));\n`);
      const next = parse(readFileSync(config, "utf8"));
      next.extensions.actions.web.argv[0] = hurl;
      next.extensions.verification.stages = ["webCheck"];
      writeFileSync(config, stringify(next));
      expect(JSON.parse(s.ok(verify))).toMatchObject({ok:true, head});
      expect(JSON.parse(readFileSync(calls, "utf8"))).toEqual(["--test", "api.hurl"]);
      const records = JSON.parse(ledger("query", "--q", "verify", "--repo", "app", "--json")).events;
      expect(records.some((item:{payload_json:string}) => {
        const record = JSON.parse(item.payload_json);
        return record.kind === "verify" && record.status === "pass" &&
          record.meta.stages.some((stage:{stage:string; exit_code:number}) => stage.stage === "webCheck" && stage.exit_code === 0);
      })).toBe(true);
    }
  } finally {
    s.cleanup();
    expect(existsSync(s.root)).toBe(false);
  }
}, 90_000);
