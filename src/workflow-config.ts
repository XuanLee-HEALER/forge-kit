import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveInstance } from "./instance";
import { parseYamlFile } from "./config";
import { findKitRoot } from "./kit-root";

export function installedInstance(root: string) {
  if (!existsSync(join(root, ".workbench/kit-lock.json"))) {
    const path = join(root, ".workbench/workbench.yaml");
    if (!existsSync(path) || !parseYamlFile<{ extensions?: unknown }>(path)?.extensions) return undefined;
  }
  return resolveInstance(root, findKitRoot());
}

export function verificationPolicy(config: ReturnType<typeof resolveInstance>) {
  const { environment, stages } = config.verification.value;
  const sequence = stages.map(id => {
    const stage = config.stages.get(id)!;
    return [id, stage.value, stage.source === "core" ? null : config.actions.get(stage.value.action)?.value ?? null];
  });
  return createHash("sha256").update(JSON.stringify([environment, sequence])).digest("hex");
}
