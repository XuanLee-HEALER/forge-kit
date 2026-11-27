import { canonicalJson, sha256String } from "./ledger/types";
import { runGit } from "./git";
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
  authorize();
  const before = remoteBranch(dir, action.ref);
  if (before !== action.baseOid) throw Error("Git did not perform the approved fast-forward. Approved remote branch changed: " + action.ref + " is " + before + ", expected " + action.baseOid);
  const refspec = action.head + ":" + action.ref;
  const result = runGit(dir, ["--no-replace-objects", "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no",
    write, refspec]);
  const after = remoteBranch(dir, action.ref);
  if (result.code) throw Error("Fast-forward rejected for " + action.ref + " at " + after +
    ", candidate " + action.head + ": " + (result.stderr.trim() || "Git exited " + result.code));
  const statuses = result.stdout.split("\n").filter(line => /^[ =*+!-]\t/.test(line));
  if (statuses.length !== 1 || !statuses[0].startsWith(" \t" + refspec + "\t"))
    throw Error("Git did not perform the approved fast-forward; inspect the remote branch");
  if (after !== action.head) throw Error("Cannot verify the exact remote update: " + action.ref + " is " + after + ", expected " + action.head);
  return action.head;
}
