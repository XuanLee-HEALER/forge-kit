// An exact plan is frozen with the runbook. Resolving it again detects changed
// scripts, endpoints or Git identities before an executor claims an item.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { prospectiveMergeTree } from "../ship-diff";
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
export function remoteBranch(dir: string, ref: string) {
  const result = runGit(dir, ["ls-remote", "--exit-code", "--refs", "origin", ref]);
  const [oid, name] = result.stdout.trim().split("\t");
  if (result.code || !isOid(oid) || name !== ref) throw Error("Cannot verify exact remote branch " + ref);
  return oid;
}
export function checkPushPermission(root: string, branch: string) {
  const policy = loadWorkbenchConfig(root).guard;
  const names = [branch, "refs/heads/" + branch];
  if (names.some(n => policy.protected_branches.includes(n)) && !names.some(n => policy.allow_protected_ff.includes(n)))
    throw Error("Protected branch requires explicit instance permission for exact fast-forward");
}
interface PinnedCommand {
  cwd: string;
  argv: string[];
  files: Record<string, string>;
}
export type ShipAction =
  | {
      kind: "push";
      repo: string;
      remote: "origin";
      ref: string;
      baseOid: string;
      head: string;
      originHash: string;
    }
  | { kind: "pr"; repo: string; number: number; url: string; head: string; base: string; baseOid: string; tree: string }
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
export function deliveryStages(cfg: ReturnType<typeof resolveInstance>) {
  return cfg.delivery.value.stages.map((id) => ({
    id,
    // At the PR endpoint, the ship slot records the hosted merge observation.
    // An instance program cannot replace that operation or gain a PR-grade write grant.
    core: id === "ship" && (cfg.delivery.value.endpoint === "pr" || cfg.stages.get(id)?.source === "core"),
  }));
}
function requireTargetObservation(endpoint: string, actions: ShipAction[]) {
  if (endpoint !== "push" && endpoint !== "pr" && !actions.some((action) => action.kind === "stage"))
    throw Error("A protected delivery endpoint requires a configured stage and independent target observer");
}
export function checkDeliveryDefinition(root: string, plan: ExactPlan) {
  const cfg = resolveInstance(root);
  requireTargetObservation(plan.endpoint, plan.actions);
  if (
    cfg.delivery.value.endpoint !== plan.endpoint ||
    canonicalJson(deliveryStages(cfg)) !== canonicalJson(plan.stages)
  )
    throw Error("Delivery endpoint, stage implementation or stage order changed");
}
export function stagePin(root: string, id: string): Extract<ShipAction, { kind: "stage" }> {
  const cfg = resolveInstance(root),
    stage = cfg.stages.get(id);
  if (!stage || stage.source === "core" || !cfg.delivery.value.stages.includes(id))
    throw Error("Expected configured delivery stage " + id);
  const action = cfg.actions.get(stage.value.action)!;
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
  pushes: string[] = [],
): ExactPlan {
  const pins = pinCheckouts(ledger, task);
  const cfg = resolveInstance(ledger.workbenchRoot);
  const sequence = deliveryStages(cfg);
  if (pushes.length || cfg.delivery.value.endpoint === "push") {
    if (cfg.delivery.value.endpoint !== "push" || ledger.getTask(task)?.endpoint !== "push" ||
        stages.length || sequence.length !== 1 || !sequence[0].core ||
        actions.prs.length || actions.tags.length || actions.sql_files.length || actions.kubectl_commands.length ||
        pushes.length !== pins.length || new Set(pins.map(p => p.repo)).size !== pins.length)
      throw Error("Exact push requires the configured push endpoint and one branch per repository");
    const updates = pins.map(pin => {
      const targets = pushes.filter(item => item.startsWith(pin.repo + ":"));
      if (targets.length !== 1) throw Error("Expected --push <repo>:<branch> for " + pin.repo);
      const branch = targets[0].slice(pin.repo.length + 1);
      const ref = "refs/heads/" + branch;
      const row = ledger.getTaskRepos(task).find(r => r.repo === pin.repo)!;
      const {dir} = resolveTaskCheckout(ledger.workbenchRoot, row);
      if (!branch || runGit(dir, ["check-ref-format", ref]).code) throw Error("Invalid push branch");
      checkPushPermission(ledger.workbenchRoot, branch);
      if (runGit(dir, ["remote", "get-url", "origin"]).stdout !== runGit(dir, ["remote", "get-url", "--push", "origin"]).stdout)
        throw Error("Push and read destinations must match");
      const baseOid = remoteBranch(dir, ref);
      if (baseOid === pin.head || runGit(dir, ["merge-base", "--is-ancestor", baseOid, pin.head]).code)
        throw Error("Exact push requires a strict fast-forward from the live remote value");
      return {kind: "push" as const, repo: pin.repo, remote: "origin" as const, ref, head: pin.head, baseOid, originHash: pin.originHash};
    });
    return { endpoint: "push", pins, actions: updates, ci: [], stages: sequence };
  }
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
    if (data.state !== "OPEN" || data.headRefOid !== pin.head || !isOid(data.baseRefOid) || data.baseRefName !== "main")
      throw Error("Pin the open PR targeting main at the verified task HEAD before the operator merges it");
    const check = {
      kind: "pr" as const,
      repo: pin.repo,
      number: Number(data.url.split("/").pop()),
      url: String(data.url),
      head: pin.head,
      base: String(data.baseRefName),
      baseOid: String(data.baseRefOid),
      tree: prospectiveMergeTree(dir, data.baseRefOid, pin.head),
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
