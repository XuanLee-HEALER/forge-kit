import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { sandbox } from "../v05-sandbox";

interface ReviewOptions {
  role?: string;
  status?: string;
  summary?: string;
  body?: string;
  session?: string;
}

export function withReviewDelivery(run: (fixture: ReturnType<typeof reviewDelivery>) => void) {
  const s = sandbox();
  try {
    run(reviewDelivery(s));
  } finally {
    s.cleanup();
    expect(existsSync(s.root)).toBe(false);
  }
}

function reviewDelivery(s: ReturnType<typeof sandbox>) {
  s.fresh();
  s.env.FORGE_SESSION_ID = "fixture-operator";
  const config = parse(s.read(".workbench/workbench.yaml"));
  const repoName = "app";
  const branch = "main";
  const task = "review-delivery";
  s.privateFile(".workbench/workbench.yaml", stringify({
    ...config, repos: [repoName],
    guard: {...config.guard, protected_branches: [branch], allow_protected_ff: [branch]},
    extensions: {
      delivery: {endpoint: "push", stages: ["ship"]},
      verification: {environment: "isolated", stages: ["check"]},
      stages: {check: {action: "check"}},
      actions: {check: {purpose: "verify", cwd: ".", argv: ["bun", "check.ts"], inputs: ["check.ts"]}},
    },
  }));
  const app = join(s.work, repoName);
  s.privateFile("app/check.ts", 'const revision = await Bun.file("revision.txt").text(); if (!revision.trim()) process.exit(1);\n');
  const git = (...args: string[]) => s.git(app, ...args).trim();
  git("init", "-b", branch);
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const head = () => git("rev-parse", "HEAD");
  function change(contents: string, file = "revision.txt") {
    s.privateFile(`app/${file}`, contents + "\n");
    git("add", "--", "check.ts", file);
    git("commit", "-m", contents);
    return head();
  }
  const base = change("baseline");
  const bare = join(s.root, "origin.git");
  s.git(s.root, "init", "--bare", "-b", branch, bare);
  git("remote", "add", "origin", bare);
  git("push", "origin", branch);
  const remote = () => s.git(bare, "rev-parse", "refs/heads/" + branch).trim();

  const ledger = (...args: string[]) => JSON.parse(s.ok([s.forge, "ledger", ...args]));
  ledger("open", "--id", task, "--title", "Exact review delivery", "--repo", repoName, "--branch", branch,
    "--base", base, "--head", base, "--endpoint", "push", "--depth", "targeted");
  const scope = `.workbench/specs/${task}/scope.md`;
  s.privateFile(scope, "A nonempty revision is successfully reviewed and verified.\n");
  const freeze = () => ledger("freeze", task, "--lock-tests", "check.ts");
  freeze();
  const status = () => ledger("status", "--task", task, "--json");
  const deliveryEvents = () => status().events.filter((event: {payload_json: string}) =>
    JSON.parse(event.payload_json).meta?.delivery_endpoint === "push");
  const reviews = () => ledger("reviews", task);
  const verify = () => expect(JSON.parse(s.ok([s.forge, "verify", "--task", task, "--cwd", app, "--mode", "all", "--offline"])))
    .toMatchObject({ok: true, head: head()});
  let reports = 0;
  function native(from: string, to: string, {
    role = "quality", status = "pass", summary = "Reviewed the pinned revision",
    body = summary + "\n", session = `fixture-${role}`,
  }: ReviewOptions = {}) {
    const report = s.privateFile(`.workbench/runs/${task}/fixture-report-${++reports}.md`, body);
    return ledger("review-record", task, "--repo", repoName, "--branch", branch, "--role", role, "--base", from, "--head", to,
      "--status", status, "--summary", summary, "--report", report, "--session-id", session);
  }
  function authorize() {
    const book = ledger("runbook", "create", "--task", task, "--exact", "--push", "app:main", "--title", "Fixture push");
    const envelope = ledger("fast-track", "prepare", task, "--runbook", book.runbook_id, "--paths", "revision.txt,side.txt");
    s.hook("UserPromptSubmit", {session_id: s.env.FORGE_SESSION_ID, prompt: envelope.approval});
    expect(ledger("fast-track", "status", envelope.envelope_id)[0].status).toBe("ACTIVE");
    return envelope.envelope_id as string;
  }
  const ship = (action: "evaluate" | "run", envelope: string) => {
    const result = s.run([s.forge, "ship", action, "--envelope", envelope]);
    return {...result, result: JSON.parse(result.out)};
  };
  function eligible(envelope: string) {
    const result = ship("evaluate", envelope);
    expect(result.code, result.err + result.out).toBe(0);
    expect(result.result).toMatchObject({ok: true, status: "ELIGIBLE"});
  }
  function blocked(envelope: string, action: "evaluate" | "run" = "evaluate") {
    const result = ship(action, envelope);
    expect(result.code, result.err + result.out).toBe(1);
    expect(result.result).toMatchObject({ok: false, receipts: []});
    return result.result.reason.message as string;
  }
  function deliver(envelope: string) {
    const target = head();
    const result = ship("run", envelope);
    expect(result.code, result.err + result.out).toBe(0);
    expect(result.result).toMatchObject({status: "REDEEMED", receipts: [{status: "confirmed", observation: target}]});
    expect(remote()).toBe(target);
    const delivery = deliveryEvents();
    expect(delivery).toHaveLength(1);
    expect(JSON.parse(delivery[0].payload_json)).toMatchObject({source: "tool", status: "pass", meta: {new_sha: target}});
    expect(ledger("close", task).task.status).toBe("CLOSED");
    expect(ledger("verify", "--task", task, "--json").ok).toBe(true);
  }
  return {s, base, task, git, head, change, remote, ledger, scope, freeze, status, deliveryEvents, reviews,
    verify, native, authorize, eligible, blocked, deliver};
}
