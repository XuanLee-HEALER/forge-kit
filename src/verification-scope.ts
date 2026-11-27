import { realpathSync } from "node:fs";

interface Scope {
  root: string;
  stage?: string;
  task?: string;
  head?: string;
}

export function enterVerificationScope(root: string, scope: Omit<Scope, "root">, env = process.env) {
  const stack: Scope[] = JSON.parse(env.FORGE_VERIFICATION_SCOPES ?? "[]");
  const current = { ...scope, root: realpathSync(root) };
  for (const ancestor of stack) {
    if (ancestor.root !== current.root) continue;
    const sameTask = !ancestor.task || !current.task ||
      (ancestor.task === current.task && ancestor.head === current.head);
    if (sameTask && (!current.stage || ancestor.stage === current.stage))
      throw Error(current.stage ? "Recursive stage invocation: " + current.stage : "Recursive verification of the same task and commit");
  }
  return JSON.stringify([...stack, current]);
}
