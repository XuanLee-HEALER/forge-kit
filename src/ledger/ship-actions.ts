// An exact plan is frozen with the runbook. Resolving it again detects changed
// scripts, endpoints or Git identities before an executor claims an item.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { atomicProtocol } from "../atomic-pr";
import { prospectiveMerge, prospectiveMergeTree } from "../conditional-merge";
import { loadDbEnvironments, loadWorkbenchConfig } from "../config";
import { localPath, readRequired, resolveInstance } from "../instance";
import { runGit } from "../git";
import { interpreterScript } from "../shared/action-program";
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
export function fatRef(dir: string) {
  const ref = "refs/heads/fat",
    r = runGit(dir, ["ls-remote", "--symref", "--exit-code", "origin", "HEAD", ref]);
  const lines = r.stdout.trim().split("\n");
  const defaultRef = lines.find((line) => line.startsWith("ref: ") && line.endsWith("\tHEAD"));
  if (!defaultRef || defaultRef === "ref: " + ref + "\tHEAD")
    throw Error("FAT target must be distinct from the verified remote default branch");
  const [sha, name] = (lines.find((line) => line.endsWith("\t" + ref)) ?? "").split("\t");
  if (r.code || name !== ref || !isOid(sha)) throw Error("Cannot verify origin refs/heads/fat");
  return sha;
}
export function checkFatProtection(root: string) {
  const caps = loadWorkbenchConfig(root).guard.protected_branches;
  if (caps.includes("fat") || caps.includes("refs/heads/fat")) throw Error("The FAT branch is protected");
}
interface PinnedCommand {
  cwd: string;
  argv: string[];
  files: Record<string, string>;
}
export type ShipAction =
  | {
      kind: "fat";
      repo: string;
      remote: "origin";
      ref: "refs/heads/fat";
      baseOid: string;
      head: string;
      targetOid: string;
      originHash: string;
    }
  | { kind: "pr"; repo: string; number: number; url: string; head: string; base: string; baseOid: string; tree: string; atomicProtocol?: string }
  | { kind: "tag"; repo: string; tag: string; head: string }
  | { kind: "stage"; stage: string; target: string; execute: PinnedCommand; observe: PinnedCommand }
  | { kind: "sql"; target: DbTarget; path: string; sha256: string };
export interface ExactPlan {
  endpoint: string;
  pins: CheckoutPin[];
  actions: ShipAction[];
  ci: Extract<ShipAction, { kind: "pr" }>[];
  stages: { id: string; core: boolean }[];
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
function deliveryStages(cfg: ReturnType<typeof resolveInstance>) {
  return cfg.delivery.value.stages.map((id) => ({
    id,
    core: cfg.stages.get(id)?.source === "core" && id === "ship",
  }));
}
function requireTargetObservation(endpoint: string, actions: ShipAction[]) {
  if (endpoint !== "fat" && endpoint !== "pr" && !actions.some((action) => action.kind === "stage"))
    throw Error("A protected delivery endpoint requires a configured stage and independent target observer");
}
export function checkDeliveryDefinition(root: string, plan: ExactPlan) {
  const cfg = resolveInstance(root);
  requireTargetObservation(plan.endpoint, plan.actions);
  if (plan.actions.some(a => a.kind === "pr" && a.atomicProtocol && !cfg.delivery.value.atomic_pr_hosts.includes(new URL(a.url).hostname)))
    throw Error("Approved atomic PR host removed from instance delivery configuration");
  if (
    cfg.delivery.value.endpoint !== plan.endpoint ||
    canonicalJson(deliveryStages(cfg)) !== canonicalJson(plan.stages)
  )
    throw Error("Delivery endpoint, stage implementation or stage order changed");
}
export function stagePin(root: string, id: string): Extract<ShipAction, { kind: "stage" }> {
  const cfg = resolveInstance(root),
    stage = cfg.stages.get(id);
  const action = stage && cfg.actions.get(stage.value.action);
  if (!action || !stage || !cfg.delivery.value.stages.includes(id))
    throw Error("Expected configured delivery stage " + id);
  const observer = stage.value.observe && cfg.actions.get(stage.value.observe);
  if (!observer || observer.value.purpose !== "observe" || stage.value.observe === stage.value.action)
    throw Error(
      "Protected stage " +
        id +
        " needs a distinct read-only observe action in extensions.stages." +
        id +
        ".observe",
    );
  const cache = new Map<string, string>();
  function pin(actionId: string, args: string[], cwdName: string, inputs?: string[]): PinnedCommand {
    if (!inputs)
      throw Error(
        "Declare every deployment input in extensions.actions." +
          actionId +
          ".inputs (use [] for no extra files)",
      );
    const cwd = localPath(root, cwdName),
      argv = [...args];
    const executable = argv[0].includes("/") ? resolve(cwd, argv[0]) : Bun.which(argv[0]);
    if (!executable) throw Error("Missing executable for " + actionId);
    argv[0] = realpathSync(executable);
    const files: Record<string, string> = {};
    const paths = new Set(inputs.map((path) => localPath(cwd, path)));
    paths.add(argv[0]);
    const script = interpreterScript(args);
    if (script) paths.add(resolve(cwd, script));
    for (const path of paths) {
      const digest = cache.get(path) ?? new Bun.CryptoHasher("sha256").update(readRequired(path)).digest("hex");
      cache.set(path, digest);
      files[path] = digest;
    }
    return { cwd, argv, files };
  }
  const execute = pin(
    action.id,
    [...action.value.argv, ...stage.value.options],
    action.value.cwd,
    action.value.inputs,
  );
  const observe = pin(observer.id, observer.value.argv, observer.value.cwd, observer.value.inputs);
  if (canonicalJson([execute.cwd, execute.argv]) === canonicalJson([observe.cwd, observe.argv]))
    throw Error("Use a separate read-only target observation for " + id);
  return { kind: "stage", stage: id, target: cfg.delivery.value.endpoint, execute, observe };
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
  fat: string[] = [],
): ExactPlan {
  const pins = pinCheckouts(ledger, task);
  const cfg = resolveInstance(ledger.workbenchRoot);
  const sequence = deliveryStages(cfg);
  if (cfg.delivery.value.endpoint === "fat") {
    checkFatProtection(ledger.workbenchRoot);
    if (
      ledger.getTask(task)?.endpoint !== "fat" ||
      sequence.length !== 1 ||
      !sequence[0].core ||
      stages.length ||
      actions.prs.length ||
      actions.tags.length ||
      actions.sql_files.length ||
      actions.kubectl_commands.length
    )
      throw Error("FAT endpoint permits only exact test-branch updates for a FAT task");
    if (
      new Set(pins.map((x) => x.repo)).size !== pins.length ||
      canonicalJson([...fat].sort()) !== canonicalJson(pins.map((p) => p.repo + ":fat").sort())
    )
      throw Error("Register --fat <repo>:fat once for every attached repository");
    const updates = pins.map((pin) => {
      const row = ledger.getTaskRepos(task).find((r) => r.repo === pin.repo)!;
      if (row.branch === "fat") throw Error("FAT delivery requires a separate source branch");
      const { dir } = resolveTaskCheckout(ledger.workbenchRoot, row);
      const get = (args: string[]) => runGit(dir, args).stdout.trim();
      if (get(["remote", "get-url", "origin"]) !== get(["remote", "get-url", "--push", "origin"]))
        throw Error("FAT fetch and push destinations must match");
      const baseOid = fatRef(dir);
      if (
        runGit(dir, ["cat-file", "-e", baseOid + "^{commit}"]).code &&
        runGit(dir, ["fetch", "--no-write-fetch-head", "--no-tags", "--refmap=", "origin", "refs/heads/fat"])
          .code
      )
        throw Error("Fetch the live FAT commit before registering this action");
      const targetOid = prospectiveMerge(dir, baseOid, pin.head);
      return {
        kind: "fat" as const,
        repo: pin.repo,
        remote: "origin" as const,
        ref: "refs/heads/fat" as const,
        head: pin.head,
        baseOid,
        targetOid,
        originHash: pin.originHash,
      };
    });
    return { endpoint: "fat", pins, actions: updates, ci: [], stages: sequence };
  }
  if (fat.length) throw Error("--fat requires the instance FAT endpoint");
  const expectedStages = sequence.filter((stage) => !stage.core).map((stage) => stage.id);
  if (canonicalJson(expectedStages) !== canonicalJson(stages))
    throw Error("Runbook must include the configured delivery stages in order: " + expectedStages.join(", "));
  const items: ShipAction[] = [];
  const ci: Extract<ShipAction, { kind: "pr" }>[] = [];
  for (const pr of actions.prs)
    if (
      pins.filter((p) => p.repo === pr.repo).length !== 1 ||
      actions.prs.filter((x) => x.repo === pr.repo).length !== 1
    )
      throw Error("Expected one exact PR per repository: " + pr.repo);
  const coreShip = sequence.some((stage) => stage.core);
  for (const pin of pins) {
    const pr = actions.prs.find((p) => p.repo === pin.repo);
    if (!pr && (coreShip || cfg.delivery.value.endpoint === "pr"))
      throw Error("Register the exact PR for " + pin.repo);
    const row = ledger.getTaskRepos(task).find((r) => r.repo === pin.repo && r.branch === pin.branch)!;
    const { dir } = resolveTaskCheckout(ledger.workbenchRoot, row);
    const data = inspectPr(dir, pin.branch, pr ? String(pr.number) : undefined, process.env, undefined, {
      baseOid: true,
      bin: process.env.FORGE_GH_BIN,
    });
    if (data.headRefOid !== pin.head || !isOid(data.baseRefOid) || data.baseRefName !== "main")
      throw Error("Expected the exact task HEAD and main PR target");
    const check = {
      kind: "pr" as const,
      repo: pin.repo,
      number: Number(data.url.split("/").pop()),
      url: String(data.url),
      head: pin.head,
      base: String(data.baseRefName),
      baseOid: String(data.baseRefOid),
      tree: prospectiveMergeTree(dir, data.baseRefOid, pin.head),
      ...(cfg.delivery.value.atomic_pr_hosts.includes(new URL(data.url).hostname) && {atomicProtocol}),
    };
    ci.push(check);
    if (pr) items.push(check);
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
  const registered = items.splice(0);
  // The ship stage positions the explicitly registered
  // PR/tag/SQL actions. Without a ship slot, these actions precede
  // the custom delivery chain. A same-name instance stage is executed normally.
  if (!sequence.some((stage) => stage.id === "ship")) items.push(...registered);
  for (const stage of sequence) {
    if (!stage.core) items.push(stagePin(ledger.workbenchRoot, stage.id));
    if (stage.id === "ship") items.push(...registered);
  }
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
  requireTargetObservation(cfg.delivery.value.endpoint, items);
  return { endpoint: cfg.delivery.value.endpoint, pins, actions: items, ci, stages: sequence };
}
