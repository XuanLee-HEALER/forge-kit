// An exact plan is frozen with the runbook. Resolving it again detects changed
// scripts, endpoints or Git identities before an executor claims an item.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { loadDbEnvironments } from "../config";
import { localPath, resolveInstance } from "../instance";
import { runGit } from "../git";
import { sha256File } from "../shared/path";
import { resolveTaskCheckout } from "./checkout";
import { inspectPr } from "./pr";
import { canonicalJson, sha256String, type LedgerReader, type RunbookActions } from "./types";

export interface CheckoutPin {
  repo: string;
  branch: string;
  head: string;
  originHash: string;
}
export interface DbTarget {
  env: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslmode: string;
  client: string;
  clientSha256: string;
}
export type ShipAction =
  | { kind: "pr"; repo: string; number: number; url: string; head: string; base: string; baseOid: string }
  | { kind: "tag"; repo: string; tag: string; head: string }
  | { kind: "stage"; stage: string; target: string; cwd: string; argv: string[]; files: Record<string, string> }
  | { kind: "sql"; target: DbTarget; path: string; sha256: string };
export interface ExactPlan {
  endpoint: string;
  pins: CheckoutPin[];
  actions: ShipAction[];
}
export const isOid = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

export function pinCheckouts(ledger: LedgerReader, task: string) {
  return ledger
    .getTaskRepos(task)
    .map((row) => {
      const { dir, registered } = resolveTaskCheckout(ledger.workbenchRoot, row);
      if (!registered) throw Error("Missing checkout for " + row.repo);
      const rev = runGit(dir, ["rev-parse", "HEAD"]);
      const origins = [
        ["remote", "get-url", "--all", "origin"],
        ["remote", "get-url", "--push", "--all", "origin"],
      ].map((args) => {
        const r = runGit(dir, args);
        if (r.code || !r.stdout.trim() || r.stdout.trim().includes("\n"))
          throw Error("Cannot pin origin for " + row.repo);
        return r.stdout.trim();
      });
      // Read and write destinations are independently bound to the pinned origin hash.
      if (rev.code || !isOid(rev.stdout.trim())) throw Error("Missing commit for " + row.repo);
      return {
        repo: row.repo,
        branch: row.branch,
        head: rev.stdout.trim(),
        originHash: sha256String(canonicalJson(origins)),
      };
    })
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.branch.localeCompare(b.branch));
}
function instanceFor(root: string) {
  const lock = JSON.parse(readFileSync(join(root, ".workbench/kit-lock.json"), "utf8"));
  return resolveInstance(root, lock.kit_root);
}
export function checkDeliveryDefinition(root: string, plan: ExactPlan) {
  const cfg = instanceFor(root),
    stages = plan.actions.filter((a) => a.kind === "stage").map((a) => a.stage);
  if (
    cfg.delivery.value.endpoint !== plan.endpoint ||
    canonicalJson(cfg.delivery.value.stages.filter((id) => id !== "ship")) !== canonicalJson(stages)
  )
    throw Error("Delivery endpoint or stage order changed");
}
export function stagePin(root: string, id: string): Extract<ShipAction, { kind: "stage" }> {
  const cfg = instanceFor(root),
    stage = cfg.stages.get(id);
  const action = stage && cfg.actions.get(stage.value.action);
  if (!action || !stage || !cfg.delivery.value.stages.includes(id))
    throw Error("Expected configured delivery stage " + id);
  const cwd = localPath(root, action.value.cwd);
  const argv = [...action.value.argv, ...stage.value.options];
  const executable = argv[0].includes("/") ? resolve(cwd, argv[0]) : Bun.which(argv[0]);
  if (!executable) throw Error("Missing stage executable: " + id);
  const resolved = realpathSync(executable),
    files: Record<string, string> = {};
  argv[0] = resolved;
  for (const arg of argv) {
    const path = isAbsolute(arg) ? arg : resolve(cwd, arg);
    if (statSync(path, { throwIfNoEntry: false })?.isFile()) {
      const digest = sha256File(path);
      if (!digest) throw Error("Unreadable stage input: " + path);
      files[path] = digest;
    }
  }
  return { kind: "stage", stage: id, target: cfg.delivery.value.endpoint, cwd, argv, files };
}
export function databaseTarget(root: string, host: string): DbTarget {
  const entries = Object.entries(loadDbEnvironments(root, { strict: true })).filter(
    ([, entry]) => entry.host === host,
  );
  if (entries.length !== 1) throw Error("SQL host must select exactly one configured database");
  const [env, entry] = entries[0];
  if (entry.engine !== "postgres" || !entry.database || !entry.rw?.user)
    throw Error("Expected a configured PostgreSQL database with a scoped write account");
  const which = Bun.which("psql");
  if (!which) throw Error("Install the PostgreSQL client before registering this SQL action");
  const client = realpathSync(which),
    clientSha256 = sha256File(client);
  if (!clientSha256) throw Error("Cannot pin the database client");
  return {
    client,
    clientSha256,
    env,
    host,
    port: entry.port ?? 5432,
    database: entry.database,
    user: entry.rw.user,
    sslmode: entry.sslmode ?? "require",
  };
}
export function buildPlan(
  ledger: LedgerReader,
  task: string,
  actions: RunbookActions,
  stages: string[],
): ExactPlan {
  const pins = pinCheckouts(ledger, task);
  const cfg = instanceFor(ledger.workbenchRoot);
  const expectedStages = cfg.delivery.value.stages.filter((id) => id !== "ship");
  if (canonicalJson(expectedStages) !== canonicalJson(stages))
    throw Error("Runbook must include the configured delivery stages in order: " + expectedStages.join(", "));
  const items: ShipAction[] = [];
  for (const pr of actions.prs) {
    const candidates = pins.filter((p) => p.repo === pr.repo);
    if (candidates.length !== 1) throw Error("Expected one task branch for " + pr.repo);
    const pin = candidates[0],
      row = ledger.getTaskRepos(task).find((r) => r.repo === pin.repo && r.branch === pin.branch)!;
    const { dir } = resolveTaskCheckout(ledger.workbenchRoot, row);
    const data = inspectPr(dir, pin.branch, String(pr.number), process.env, undefined, {
      baseOid: true,
      bin: process.env.FORGE_GH_BIN,
    });
    if (data.headRefOid !== pin.head || !isOid(data.baseRefOid) || data.baseRefName !== "main")
      throw Error("Expected the exact task HEAD and main PR target");
    items.push({
      kind: "pr",
      repo: pr.repo,
      number: pr.number,
      url: data.url,
      head: pin.head,
      base: data.baseRefName,
      baseOid: data.baseRefOid,
    });
  }
  for (const tag of actions.tags) {
    if (
      !pins.some((p) => p.repo === tag.repo && p.head === tag.sha) ||
      runGit(ledger.workbenchRoot, ["check-ref-format", "refs/tags/" + tag.tag]).code
    )
      throw Error("Expected a valid tag and exact attached HEAD");
    items.push({ kind: "tag", repo: tag.repo, tag: tag.tag, head: tag.sha });
  }
  for (const sql of actions.sql_files)
    items.push({
      kind: "sql",
      target: databaseTarget(ledger.workbenchRoot, sql.host),
      path: sql.path,
      sha256: sql.sha256,
    });
  if (actions.kubectl_commands.length)
    throw Error(
      "Register a deployment as a versioned instance stage to bind its target, configuration and script",
    );
  for (const stage of stages) items.push(stagePin(ledger.workbenchRoot, stage));
  if (!items.length || new Set(items.map((a) => canonicalJson(a))).size !== items.length)
    throw Error("Expected distinct exact runbook actions");
  if (items.some((a) => a.kind === "tag")) {
    for (const tag of actions.tags) {
      const row = ledger.getTaskRepos(task).find((r) => r.repo === tag.repo)!;
      const { dir } = resolveTaskCheckout(ledger.workbenchRoot, row);
      if (
        runGit(dir, ["remote", "get-url", "origin"]).stdout.trim() !==
        runGit(dir, ["remote", "get-url", "--push", "origin"]).stdout.trim()
      )
        throw Error("Cannot verify tag destination when fetch and push remotes differ");
    }
  }
  return { endpoint: cfg.delivery.value.endpoint, pins, actions: items };
}
