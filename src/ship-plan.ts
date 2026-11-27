import { git } from "./ship-diff";
import { repoOrigin } from "./shared/gh-remote";
import { resolveInstance } from "./instance";
import { remoteBranch, deliveryStages, buildPlan, isOid, type ExactPlan } from "./ledger/ship-actions";
import { runProcess, checkoutEnvironment } from "./git";
import type { Ledger } from "./ledger/store";
import { preparedScope, envelope, trackEvent, type Envelope } from "./ledger/fast-track";
import { inspectPr } from "./ledger/pr";
import { canonicalJson } from "./ledger/types";
import { withImmediateTx } from "./ledger/transactions";
import { checkEnvelopeApproval, approvedCheckouts, AwaitingOperator } from "./ship-preflight";

export function resolveFrontPlan(ledger: Ledger, e: Envelope, execute: boolean) {
  const {anchor} = preparedScope(ledger, e);
  if (anchor.mode !== "frozen-scope-v1") return;
  const bound = ledger.db.query("SELECT runbook_id FROM exact_ship_envelopes WHERE envelope_id=?").get(e.envelope_id);
  if (bound) return;
  const {checkouts, pins} = approvedCheckouts(ledger, e);
  const cfg = resolveInstance(ledger.workbenchRoot);
  const sequence = deliveryStages(cfg);
  const stages = sequence.filter(stage => !stage.core).map(stage => stage.id);
  const prs: {repo: string; number: number}[] = [];
  const targetBases = new Map<string,string>();
  const requiresPr = cfg.delivery.value.endpoint === "pr" || sequence.some(stage => stage.core);
  for (const {dir, row, pin} of requiresPr ? checkouts : []) {
    const origin = repoOrigin(dir);
    if (!origin || row.branch === "main" || row.branch.startsWith("-")) throw Error("Expected a feature branch in the approved repository");
    const slug = [origin.host, origin.owner, origin.repo].join("/");
    const gh = (args: string[]) => {
      const r = runProcess([process.env.FORGE_GH_BIN || "gh", ...args], {cwd: dir, env: checkoutEnvironment()});
      if (r.code) throw Error("Cannot confirm PR " + args[1] + " outcome: " + r.stderr.trim());
      return r.stdout;
    };
    const list = JSON.parse(gh(["pr","list","--repo",slug,"--state","open","--head",row.branch,"--limit","2","--json","number,baseRefName"]));
    if (!Array.isArray(list) || list.length > 1 || list.some(p => p.baseRefName !== "main" || !Number.isSafeInteger(p.number) || p.number < 1))
      throw Error("Ambiguous or unexpected task PR");
    const ref = "refs/heads/" + row.branch;
    const remote = git(dir, ["ls-remote","--refs","origin",ref]).trim();
    const base = gh(["api","--hostname",origin.host,"repos/" + origin.owner + "/" + origin.repo + "/git/ref/heads/main","--jq",".object.sha"]).trim();
    if (!isOid(base)) throw Error("Cannot identify the target main OID before PR registration");
    targetBases.set(row.repo,base);
    let selector = list.length ? String(list[0].number) : undefined;
    if (remote !== pin.head + "\t" + ref || !selector) {
      const destination = slug + " " + row.branch + "@" + pin.head + " -> main@" + base;
      if (!execute || !anchor.node_authorization)
        throw new AwaitingOperator("Source branch publication and PR creation pending for " + destination);
      const write = git(dir, ["remote", "get-url", "--push", "--all", "origin"]).trim();
      if (write !== git(dir, ["remote", "get-url", "--all", "origin"]).trim())
        throw Error("PR source push and read destinations differ");
      if (remote !== pin.head + "\t" + ref) {
        checkEnvelopeApproval(ledger, envelope(ledger, e.envelope_id));
        git(dir, ["push", "--no-follow-tags", "--recurse-submodules=no", "origin", pin.head + ":" + ref]);
        if (remoteBranch(dir, ref) !== pin.head) throw Error("Cannot verify published PR source branch");
      }
      if (!selector) {
        checkEnvelopeApproval(ledger, envelope(ledger, e.envelope_id));
        selector = gh(["pr", "create", "--repo", slug, "--head", row.branch, "--base", "main", "--fill"]).trim();
      }
    }
    const pr = inspectPr(dir,row.branch,selector,process.env,undefined,{bin:process.env.FORGE_GH_BIN,baseOid:true});
    if (pr.state !== "OPEN" || pr.headRefOid !== pin.head || pr.baseRefName !== "main" || pr.baseRefOid !== base)
      throw Error("Task PR differs from the authorized version or target");
    prs.push({repo:row.repo, number:Number(pr.url.split("/").pop())});
  }
  function checkCandidate(plan: ExactPlan) {
    if (canonicalJson(plan.pins) !== canonicalJson(pins) || plan.ci.some(pr => targetBases.get(pr.repo) !== pr.baseOid))
      throw Error("Task or target version changed during plan registration");
    return plan;
  }
  if (!execute) {
    const actions = {prs, tags: [], sql_files: [], kubectl_commands: []};
    return checkCandidate(buildPlan(ledger, e.task_id, actions, stages));
  }
  withImmediateTx(ledger.db, () => {
    checkEnvelopeApproval(ledger, envelope(ledger, e.envelope_id));
    if (ledger.db.query("SELECT 1 FROM exact_ship_envelopes WHERE envelope_id=?").get(e.envelope_id)) return;
    const rb = ledger.createRunbook({task_id:e.task_id, title:"Realize frozen scope " + e.envelope_id, exact_stages:stages, actions:{prs}});
    const plan: ExactPlan = JSON.parse(rb.actions_json).exact;
    checkCandidate(plan);
    ledger.db.query("UPDATE runbooks SET status='APPROVED',approved_session_id=?,approved_at=?,expires_at=? WHERE runbook_id=?")
      .run(e.approved_session_id,e.approved_at,e.expires_at,rb.runbook_id);
    ledger.db.query("INSERT INTO exact_ship_envelopes(envelope_id,runbook_id,actions_hash,endpoint) VALUES(?,?,?,?)")
      .run(e.envelope_id,rb.runbook_id,rb.actions_hash,plan.endpoint);
    trackEvent(ledger,e,"SHIP_PLAN_BOUND",{runbook_id:rb.runbook_id,actions_hash:rb.actions_hash,endpoint:plan.endpoint});
  });
}
