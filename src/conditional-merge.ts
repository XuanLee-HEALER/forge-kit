import { statSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutEnvironment, runGit, runProcess } from "./git";
import { parseGitRemoteRepo, repoOrigin } from "./shared/gh-remote";
import { git } from "./ship-diff";
import { canonicalJson, sha256String } from "./ledger/types";

// pre-push receives the remote OID from *this* receive-pack exchange, before
// Git transmits its update. The server subsequently compares the same OID
// under its ref lock. An earlier ls-remote cannot provide that guarantee.
const guard = `#!/bin/sh
set -eu
cat > "$FORGE_PUSH_INPUT"
{
  IFS=' ' read -r local_ref new_oid remote_ref old_oid
  test "$new_oid" = "$FORGE_PUSH_NEW" && test "$old_oid" = "$FORGE_PUSH_OLD" && test "$remote_ref" = "$FORGE_PUSH_REF" || exit 1
  if IFS= read -r unexpected; then exit 1; fi
} < "$FORGE_PUSH_INPUT"
if test -n "$FORGE_PREVIOUS_PRE_PUSH"; then
  "$FORGE_PREVIOUS_PRE_PUSH" "$@" < "$FORGE_PUSH_INPUT"
fi
`;

function withMergeObject<T>(
  dir: string,
  base: string,
  head: string,
  use: (target: string, env: Record<string, string | undefined>) => T,
) {
  const temp = mkdtempSync(join(tmpdir(), "forge-merge-objects-"));
  try {
    const identity = git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]).trim();
    const objectDir = mkdtempSync(join(temp, "objects-"));
    const env = {
      ...checkoutEnvironment(),
      GIT_OBJECT_DIRECTORY: objectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: identity,
    };
    let target = head;
    if (!runGit(dir, ["merge-base", "--is-ancestor", head, base]).code) target = base;
    else if (runGit(dir, ["merge-base", "--is-ancestor", base, head]).code) {
      const tree = git(dir, ["merge-tree", "--write-tree", base, head], env).trim();
      const time = git(dir, ["show", "-s", "--format=%cI", head]).trim();
      target = git(
        dir,
        [
          "-c",
          "user.name=forge-kit",
          "-c",
          "user.email=forge@localhost",
          "commit-tree",
          tree,
          "-p",
          base,
          "-p",
          head,
          "-m",
          "Merge approved revision " + head,
        ],
        { ...env, GIT_AUTHOR_DATE: time, GIT_COMMITTER_DATE: time },
      ).trim();
    }
    return use(target, env);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
export function prospectiveMerge(dir: string, base: string, head: string) {
  return withMergeObject(dir, base, head, (target) => target);
}
export function mergePinnedHead(
  dir: string,
  branch: string,
  base: string,
  head: string,
  validate: (target: string, env: Record<string, string | undefined>) => void,
  authorize: () => void,
  expectedOrigin?: string,
) {
  if (
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head) ||
    runGit(dir, ["check-ref-format", "refs/heads/" + branch]).code
  )
    throw Error("Invalid pinned Git reference");
  const temp = mkdtempSync(join(tmpdir(), "forge-conditional-push-"));
  try {
    const url = git(dir, ["remote", "get-url", "--push", "--all", "origin"]).trim();
    const fetchUrl = git(dir, ["remote", "get-url", "--all", "origin"]).trim();
    if (expectedOrigin && sha256String(canonicalJson([fetchUrl, url])) !== expectedOrigin)
      throw Error("Approved remote changed before conditional update");
    const destination = parseGitRemoteRepo(url),
      source = repoOrigin(dir);
    const sameTransport = branch === "fat" && url === fetchUrl && !url.includes("\n");
    if (
      !sameTransport &&
      (!source ||
        !destination ||
        url.includes("\n") ||
        destination.host !== source.host ||
        destination.owner !== source.owner ||
        destination.repo !== source.repo)
    )
      throw Error("Push transport must identify the exact approved PR repository");
    const hook = git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"]).trim();
    return withMergeObject(dir, base, head, (target, env) => {
      validate(target, env);
      const ref = "refs/heads/" + branch;
      const script = join(temp, "pre-push");
      writeFileSync(script, guard, { mode: 0o700 });
      const prior = (statSync(hook, { throwIfNoEntry: false })?.mode ?? 0) & 0o111 ? hook : "";
      authorize();
      const push = runProcess(
        [
          "git",
          "-C",
          dir,
          "-c",
          "core.hooksPath=" + temp,
          "push",
          "--porcelain",
          "--no-follow-tags",
          "--recurse-submodules=no",
          url,
          target + ":" + ref,
        ],
        {
          env: {
            ...env,
            FORGE_PUSH_INPUT: join(temp, "advertised"),
            FORGE_PUSH_NEW: target,
            FORGE_PUSH_OLD: base,
            FORGE_PUSH_REF: ref,
            FORGE_PREVIOUS_PRE_PUSH: prior,
          },
          timeoutMs: 60_000,
        },
      );
      if (push.code)
        throw Error(
          "Conditional PR update refused. Check the live base, existing hooks and remote branch protection; manual delivery may be required.",
        );
      return target;
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
