import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { Ledger } from "../src/ledger";
import { sandbox } from "./v05-sandbox";

for (const scenario of ["pass", "fallback", "adjacent", "blocked"] as const) test(
  `exact delivery waits for a native full-range pass with ${scenario} review evidence`, () => {
    const s = sandbox();
    const task = "review-delivery";
    try {
      s.fresh();
      s.env.FORGE_SESSION_ID = "fixture-operator";
      const config = parse(s.read(".workbench/workbench.yaml"));
      s.privateFile(".workbench/workbench.yaml", stringify({ ...config, repos: ["app"],
        guard: {...config.guard, protected_branches: ["main"], allow_protected_ff: ["main"]},
        extensions: {
          delivery: {endpoint: "push", stages: ["ship"]},
          verification: {environment: "isolated", stages: ["check"]},
          stages: {check: {action: "check"}},
          actions: {check: {purpose: "verify", cwd: ".", argv: ["bun", "check.ts"], inputs: ["check.ts"]}},
        },
      }));
      const repo = join(s.work, "app");
      mkdirSync(repo);
      const git = (...args: string[]) => s.git(repo, ...args).trim();
      git("init", "-b", "main");
      git("config", "user.name", "Fixture");
      git("config", "user.email", "fixture@example.invalid");
      s.privateFile("app/check.ts", 'const revision = await Bun.file("revision.txt").text(); if (!revision.trim()) process.exit(1);\n');
      function change(contents: string) {
        s.privateFile("app/revision.txt", contents);
        git("add", "--", "check.ts", "revision.txt");
        git("commit", "-m", contents.trim(), "--", "check.ts", "revision.txt");
        return git("rev-parse", "HEAD");
      }
      const base = change("baseline\n");
      const bare = join(s.root, "origin.git");
      s.git(s.root, "init", "--bare", "-b", "main", bare);
      git("remote", "add", "origin", bare);
      git("push", "origin", "main");
      const remote = () => s.git(bare, "rev-parse", "refs/heads/main").trim();

      const ledger = (...args: string[]) => JSON.parse(s.ok([s.forge, "ledger", ...args]));
      ledger("open", "--id", task, "--title", "Exact review delivery", "--repo", "app", "--branch", "main",
        "--base", base, "--head", base, "--endpoint", "push", "--depth", "targeted");
      s.privateFile(`.workbench/specs/${task}/scope.md`, "A nonempty revision is successfully reviewed and verified.\n");
      ledger("freeze", task, "--lock-tests", "check.ts");
      function native(from: string, to: string, role = "quality", status = "pass", summary = "Reviewed the pinned revision") {
        const report = s.privateFile(`.workbench/runs/${task}/${role}-${status}-${to}-${from}.md`, summary + "\n");
        return ledger("review-record", task, "--repo", "app", "--branch", "main", "--role", role, "--base", from, "--head", to,
          "--status", status, "--summary", summary, "--report", report, "--session-id", "fixture-reviewer");
      }
      const middle = change("intermediate change\n");
      if (scenario === "adjacent") native(base, middle);
      const head = change("final change\n");
      let failure: number | undefined;
      if (scenario === "adjacent") native(middle, head);
      else if (scenario === "blocked") {
        native(base, head, "business");
        failure = native(base, head, "quality", "blocked", "Fixture quality finding").seq;
      } else {
        // Use the ledger writer only for the retired tool's fixture receipt.
        const db = new Ledger(s.work);
        try {
          const spec = db.getSpecState(task);
          db.recordEvidence({task_id: task, repo: "app", branch: "main", sha: head, kind: "review",
            actor: "tool", source: "tool", status: scenario, summary: "Historical full review",
            meta: {role: "quality", base, head, review_task_id: task, freeze_seq: spec.freeze_seq,
              review_floor_seq: spec.evidence_floor_seq.review, ...(scenario === "pass" ? {report_status: "pass"} : {})}});
        } finally { db.closeDb(); }
      }
      const historical = ledger("reviews", task);
      if (scenario === "pass" || scenario === "fallback")
        expect(historical).toMatchObject([{ source: "tool", role: "quality", status: scenario, base, head }]);
      expect(JSON.parse(s.ok([s.forge, "verify", "--task", task, "--cwd", repo, "--mode", "all", "--offline"])))
        .toMatchObject({ok: true, head});
      function authorize() {
        const book = ledger("runbook", "create", "--task", task, "--exact", "--push", "app:main", "--title", "Fixture push");
        const envelope = ledger("fast-track", "prepare", task, "--runbook", book.runbook_id, "--paths", "revision.txt");
        s.hook("UserPromptSubmit", {session_id: "fixture-operator", prompt: envelope.approval});
        expect(ledger("fast-track", "status", envelope.envelope_id)[0].status).toBe("ACTIVE");
        return [s.forge, "ship", "run", "--envelope", envelope.envelope_id];
      }
      const ship = authorize();
      const before = ledger("status", "--task", task, "--json");
      const blocked = s.run(ship);
      expect(blocked.code, blocked.err + blocked.out).toBe(1);
      const diagnostic = JSON.parse(blocked.out);
      const expectedDiagnostic = failure ? new RegExp(`quality[^\\n]*#${failure}\\b`) : /independent review/i;
      expect(diagnostic.reason.message).toMatch(expectedDiagnostic);
      expect(diagnostic.receipts).toEqual([]);
      expect(remote()).toBe(base);
      const ordinaryClose = s.run([s.forge, "ledger", "close", task]);
      expect(ordinaryClose.code).toBe(1);
      expect(ordinaryClose.out + ordinaryClose.err).toMatch(expectedDiagnostic);
      const after = ledger("status", "--task", task, "--json");
      expect(after.task.status).toBe("OPEN");
      const delivered = (event: {payload_json: string}) => JSON.parse(event.payload_json).meta?.delivery_endpoint === "push";
      expect(after.events.filter(delivered)).toEqual(before.events.filter(delivered));

      if (scenario === "fallback") {
        const reason = "Operator records incomplete review on the old task";
        expect(ledger("close", task, "--force-incomplete", "--reason", reason).task.status).toBe("CLOSED");
        const closed = ledger("status", "--task", task, "--json").events.at(-1);
        expect(JSON.parse(closed.payload_json)).toMatchObject({force_incomplete: true, force_reason: reason});
        expect(ledger("reviews", task)).toEqual(historical);
        expect(remote()).toBe(base);
        return;
      }

      native(base, head, "quality", "pass", failure ? `Verified the quality repair #${failure}` : undefined);
      expect(JSON.parse(s.ok(authorize()))).toMatchObject({status: "REDEEMED", receipts: [{status: "confirmed", observation: head}]});
      expect(remote()).toBe(head);
      const delivery = ledger("status", "--task", task, "--json").events.filter(delivered);
      expect(delivery).toHaveLength(1);
      expect(JSON.parse(delivery[0].payload_json)).toMatchObject({source: "tool", status: "pass", meta: {new_sha: head}});
      expect(ledger("close", task).task.status).toBe("CLOSED");
      expect(ledger("reviews", task).slice(0, historical.length)).toEqual(historical);
      expect(ledger("verify", "--task", task, "--json").ok).toBe(true);
    } finally {
      s.cleanup();
      expect(existsSync(s.root)).toBe(false);
    }
  }, 30_000,
);
