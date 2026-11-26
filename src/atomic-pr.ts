import { checkoutEnvironment, runProcess } from "./git";
import { type ShipAction } from "./ledger/ship-actions";

type Pr = Extract<ShipAction, { kind: "pr" }>;
export const atomicProtocol = "forge.atomic-pr.v1";
const guards = [
  "base_branch",
  "base_oid",
  "head_oid",
  "merge_tree",
  "open_pr",
  "protected_branch_rules",
  "required_checks",
];
const manual =
  "The PR host cannot guarantee all approved conditions atomically. Hand off for a protected manual PR merge.";

function hostApi(dir: string, url: URL, route: string, args: string[]) {
  const [owner, repo] = url.pathname.split("/").slice(1, 3);
  return runProcess(
    [
      process.env.FORGE_GH_BIN || "gh",
      "api",
      "--hostname",
      url.host,
      "repos/" + owner + "/" + repo + "/forge/atomic-pr/v1/" + route,
      ...args,
    ],
    { cwd: dir, env: checkoutEnvironment() },
  );
}

/** Only a trusted PR host may enforce these conditions, in its own merge transaction. */
export function requireAtomicHost(dir: string, a: Pr) {
  const url = new URL(a.url);
  if (a.atomicProtocol !== atomicProtocol || url.protocol !== "https:" || url.hostname === "github.com")
    throw Error(manual);
  const response = hostApi(dir, url, "capabilities", ["--method", "GET"]);
  let cap;
  try {
    cap = JSON.parse(response.stdout);
  } catch {
    throw Error(manual);
  }
  if (
    response.code ||
    cap?.protocol !== atomicProtocol ||
    cap.repository !== url.origin + url.pathname.split("/").slice(0, 3).join("/") ||
    !Array.isArray(cap.preconditions) ||
    !guards.every((guard) => cap.preconditions.includes(guard))
  )
    throw Error(manual);
}

export function mergeHostedPr(dir: string, a: Pr, authorize: () => void) {
  requireAtomicHost(dir, a);
  authorize();
  const url = new URL(a.url);
  const response = hostApi(dir, url, "pulls/" + a.number + "/merge", [
    "--method",
    "POST",
    "-f",
    "protocol=" + atomicProtocol,
    "-f",
    "pull_request=" + a.url,
    "-f",
    "expected_state=OPEN",
    "-f",
    "expected_head_oid=" + a.head,
    "-f",
    "expected_base_branch=" + a.base,
    "-f",
    "expected_base_oid=" + a.baseOid,
    "-f",
    "expected_merge_tree=" + a.tree,
    "-f",
    "policy=protected_branch_rules_and_required_checks",
  ]);
  if (response.code)
    throw Error(
      "Atomic PR merge refused or unconfirmed. Inspect the hosted PR and hand off for manual resolution.",
    );
}
