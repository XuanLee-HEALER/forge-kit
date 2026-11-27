import { repoOrigin } from "../shared/gh-remote";
import { isOid, checkoutEnvironment, runProcess } from "../git";

export class PrUnavailable extends Error {}

export function inspectPr(dir: string, branch: string, pr?: string, env = process.env, timeoutMs?: number, options?:{bin?:string;mergeability?:boolean;baseOid?:boolean}) {
  const origin = repoOrigin(dir);
  if (!origin) throw new Error("Expected a GitHub origin");
  const slug = origin.owner + "/" + origin.repo;
  const urlPrefix = "https://" + origin.host + "/" + slug + "/pull/";
  function prNumber(url: unknown) {
    if (typeof url !== "string") return null;
    let canonical: string;
    try { canonical = new URL(url).href; } catch { return null; }
    if (!canonical.toLowerCase().startsWith(urlPrefix)) return null;
    const num = canonical.slice(urlPrefix.length);
    return /^[1-9]\d*$/.test(num) ? num : null;
  }
  const number = pr && (/^[1-9]\d*$/.test(pr) ? pr : prNumber(pr));
  const selector = pr ? (number ? pr : null) : branch;
  if (!selector || selector.startsWith("-")) throw new Error("Expected a PR number or URL in origin");
  const result = runProcess([options?.bin ?? "gh", "pr", "view", selector, "--repo", origin.host + "/" + slug, "--json",
    "url,state,baseRefName,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner"+(options?.baseOid?",baseRefOid,mergeCommit":"")+(options?.mergeability?",mergeable,mergeStateStatus":"")], { cwd: dir, env: checkoutEnvironment(env), timeoutMs });
  if (result.code)
    throw new PrUnavailable(
      "Unable to verify pull request: " +
        (result.stderr.trim() || "gh pr view exited with code " + result.code),
    );
  const data = JSON.parse(result.stdout);
  if (!prNumber(data.url) || (pr && prNumber(data.url) !== number) || data.isCrossRepository !== false ||
      data.headRepository?.name?.toLowerCase() !== origin.repo || data.headRepositoryOwner?.login?.toLowerCase() !== origin.owner ||
      !["OPEN", "MERGED"].includes(data.state) || data.headRefName !== branch || !isOid(data.headRefOid))
    throw new Error("Pull request does not match origin, branch, state or HEAD");
  return data;
}

export function verifiedPr(dir: string, branch: string, head: string, pr?: string, env = process.env, baseOid = false) {
  const data = inspectPr(dir, branch, pr, env, undefined, {baseOid});
  if (data.headRefOid !== head) throw Error("Pull request does not match origin, branch, state or HEAD");
  return data;
}
