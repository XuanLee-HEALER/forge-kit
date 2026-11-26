import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { localPath, readRequired, resolveInstance, verificationDirectory } from "./instance";
import { runGit } from "./git";
import { parseYamlFile } from "./config";
import { findKitRoot } from "./kit-root";

export function installedInstance(root: string) {
  if (!existsSync(join(root, ".workbench/kit-lock.json"))) {
    const path = join(root, ".workbench/workbench.yaml");
    if (!existsSync(path) || !parseYamlFile<{ extensions?: unknown }>(path)?.extensions) return undefined;
  }
  return resolveInstance(root, findKitRoot());
}

export function verificationPolicy(root: string, repo: string, head: string, config: ReturnType<typeof resolveInstance>) {
  const { environment, stages } = config.verification.value;
  const digests = new Map<string, string>();
  const sequence = stages.map(id => {
    const stage = config.stages.get(id)!;
    if (stage.source === "core") return [id, stage.value, null];
    const action = config.actions.get(stage.value.action)!.value;
    const directory = verificationDirectory(root, repo, action.cwd, config.repos);
    const paths = new Set<string>();
    const pinned: [string, string][] = [];
    for (const input of action.inputs ?? []) {
      if (directory.target === "instance") paths.add(localPath(directory.path, input));
      else {
        const path = join(directory.path, input);
        const entry = runGit(localPath(root, repo), ["ls-tree", "-z", head, "--", ":(literal)" + path]);
        const match = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(entry.stdout);
        if (entry.code || !match) throw Error("Missing verification input at selected commit: " + path);
        pinned.push([path, match[1]]);
      }
    }
    // Relative repository files already belong to the verified commit. Instance
    // programs, script arguments and explicitly declared data can change independently.
    const argv = [...action.argv, ...stage.value.options];
    for (const [i, arg] of argv.entries()) {
      let path: string | null = null;
      if (isAbsolute(arg)) path = arg;
      else if (directory.target === "instance") path = resolve(directory.path, arg);
      if (i === 0 && !arg.includes("/")) path = Bun.which(arg, { cwd: directory.target === "instance" ? directory.path : localPath(root, repo) });
      if (!path) continue;
      const rel = relative(root, path);
      if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) continue;
      if (statSync(path, { throwIfNoEntry: false })?.isFile()) paths.add(path);
    }
    const files = [...paths].sort().map(path => {
      const target = realpathSync(path);
      const rel = relative(root, target);
      if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
        throw Error("Verification input points outside the workbench: " + relative(root, path));
      let digest = digests.get(target);
      if (!digest) {
        digest = createHash("sha256").update(readRequired(target)).digest("hex");
        digests.set(target, digest);
      }
      return [relative(root, path), digest];
    });
    return [id, stage.value, action, files, pinned];
  });
  return createHash("sha256").update(JSON.stringify([environment, sequence])).digest("hex");
}
