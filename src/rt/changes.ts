import { readChangesGit, type ChangesRepo } from "./changes-git";
import { readChangesLedger } from "./changes-ledger";

export { ChangesError, resolveChangesRefs, selectChangesRepo } from "./changes-git";
export type { ChangesRepo } from "./changes-git";

type ChangesOptions = Parameters<typeof readChangesGit>[1];

export async function readLocalChanges(root: string, repo: ChangesRepo, options: ChangesOptions) {
  const { git, live_anchored, truncated, warnings } = readChangesGit(repo, options);
  const history = readChangesLedger(root, repo.repo, options.limit);
  return { repo: repo.repo, git, ledger: history.ledger, live_anchored, truncated, warnings: [...warnings, ...history.warnings] };
}

export type LocalChanges = Awaited<ReturnType<typeof readLocalChanges>>;

export function boundLocalChanges(local: LocalChanges, limits: { max_bytes: number; max_lines: number }): LocalChanges {
  const { commits } = local.git;
  const { records } = local.ledger;
  const result: LocalChanges = {
    ...local,
    git: { ...local.git, commits: [] },
    ledger: { ...local.ledger, records: [] },
  };
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  let remaining = limits.max_bytes - bytes(result);
  let lines = limits.max_lines;

  function retain<T>(item: T | undefined, selected: T[]) {
    if (item === undefined) return;
    const cost = bytes(item) + Number(selected.length > 0);
    if (!lines || cost > remaining) {
      result.truncated = true;
      return;
    }
    remaining -= cost;
    lines--;
    selected.push(item);
  }

  // Both sources retain recent records even when one can fill the whole budget.
  for (let index = 0; index < Math.max(commits.length, records.length); index++) {
    retain(commits[index], result.git.commits);
    retain(records[index], result.ledger.records);
  }
  return result;
}
