import { canonicalRepoPath } from "../config";
import { isOid, checkoutEnvironment, runGit, runProcess } from "../git";
import { usesV05 } from "./types";
import { verifiedPr } from "./pr";
import { prRemoteRefs, reachableFromRefs, resolveTaskCheckout } from "./checkout";
import type { Ledger } from "./store";

function attached(ledger: Ledger, task: string, repo: string, branch?: string) {
  const rows = ledger.getTaskRepos(task).filter(r => r.repo === canonicalRepoPath(ledger.workbenchRoot,repo) && (!branch || r.branch === branch));
  if (ledger.getTask(task)?.status !== "OPEN" || rows.length !== 1)
    throw new Error("Expected one open task attachment; specify --branch for multiple branches");
  return rows[0];
}

function commit(dir: string, ref: string) {
  const r = runGit(dir, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]);
  if (r.code) throw new Error("Cannot resolve commit " + ref);
  return r.stdout.trim();
}

function mainContainsHead(dir:string, url:string, head:string):string {
  const pr=new URL(url), repo=pr.pathname.split("/").slice(1,3).join("/");
  const api=(path:string,jq:string)=>runProcess([process.env.FORGE_GH_BIN || "gh","api","--hostname",pr.host,"repos/"+repo+"/"+path,"--jq",jq],{cwd:dir,env:checkoutEnvironment()});
  const result=api("git/ref/heads/main",".object.sha"), tip=result.stdout.trim();
  if(result.code || !isOid(tip)) throw Error("Cannot verify current remote main");
  if(head===tip || runGit(dir,["merge-base","--is-ancestor",head,tip]).code===0) return tip;
  const comparison=api("compare/"+head+"..."+tip,".status");
  if(comparison.code || !["identical","ahead"].includes(comparison.stdout.trim())) throw Error("Remote main does not contain the verified PR head");
  return tip;
}

export function syncPr(ledger: Ledger, task: string, repo: string, pr?: string, branch?: string, beforeRecord?:()=>void) {
  const attachment = attached(ledger, task, repo, branch);
  const { dir } = resolveTaskCheckout(ledger.workbenchRoot, attachment);
  const branchRef = "refs/heads/" + attachment.branch;
  function currentHead(row: typeof attachment) {
    const exists = runGit(dir, ["show-ref", "--verify", "--quiet", branchRef]);
    if (exists.code === 0) return commit(dir, branchRef);
    if (exists.code !== 1 || !pr || !row.head_sha || !reachableFromRefs(dir, row.head_sha, prRemoteRefs(dir, attachment.branch)))
      throw new Error("After branch cleanup, supply --pr and a recorded head reachable from the origin feature or default branch");
    return row.head_sha;
  }
  const head = currentHead(attachment);
  const data = verifiedPr(dir, attachment.branch, head, pr);
  const mergedMain = usesV05(ledger,task) && data.state==="MERGED" && data.baseRefName==="main"
    ? mainContainsHead(dir,data.url,head) : null;
  return ledger.db.transaction(() => {
    beforeRecord?.();
    const live = attached(ledger, task, repo, attachment.branch);
    if (resolveTaskCheckout(ledger.workbenchRoot, live).dir !== dir || currentHead(live) !== head) throw new Error("Branch advanced while verifying PR");
    ledger.db.query("UPDATE task_repos SET head_sha = ? WHERE task_id = ? AND canonical_repo(repo) = canonical_repo(?) AND branch = ?")
      .run(head, task, repo, attachment.branch);
    return ledger.recordEvidence({ task_id: task, repo, branch: attachment.branch, sha: head, kind: "pr",
      source: "tool", actor: "tool", status: "pass", summary: data.url, meta: { state: data.state, pr_url: data.url, pr_head_oid: data.headRefOid, ...(mergedMain && {base_branch:"main",target_oid:mergedMain}) } });
  }).immediate();
}
