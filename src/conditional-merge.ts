import { canonicalJson, sha256String } from "./ledger/types";
import { git } from "./ship-diff";
import { remoteBranch, type ShipAction } from "./ledger/ship-actions";

export function pushFastForward(dir: string, action: Extract<ShipAction, {kind: "push"}>, authorize: () => void) {
  const read = git(dir, ["remote", "get-url", "--all", "origin"]).trim();
  const write = git(dir, ["remote", "get-url", "--push", "--all", "origin"]).trim();
  if (!read || read !== write || read.includes("\n") ||
      sha256String(canonicalJson([read, write])) !== action.originHash)
    throw Error("Remote destination differs from the approved branch");
  if (!action.ref.startsWith("refs/heads/") || action.baseOid === action.head)
    throw Error("Expected a strict fast-forward to a registered branch");
  git(dir, ["check-ref-format", action.ref]);
  git(dir, ["--no-replace-objects", "merge-base", "--is-ancestor", action.baseOid, action.head]);
  if (remoteBranch(dir, action.ref) !== action.baseOid) throw Error("Approved remote branch changed");
  authorize();
  git(dir, ["--no-replace-objects", "push", "--no-follow-tags", "--recurse-submodules=no",
    "--force-with-lease=" + action.ref + ":" + action.baseOid, write, action.head + ":" + action.ref]);
  if (remoteBranch(dir, action.ref) !== action.head) throw Error("Cannot verify the exact remote update");
  return action.head;
}
