import { type ApprovedRunbookEntry } from "./runbook-state";
import { normalizeKubectlTokens } from "../ledger/runbook";
import { splitShellSegments, splitShellTokens, tokenizeSimpleShellCommand } from "../shared/shell";

const KUBECTL_READ_VERBS = new Set([
  "get", "describe", "logs", "top", "version", "explain", "api-resources",
  "api-versions", "cluster-info", "events", "wait", "diff",
]);

const KUBECTL_READ_SUB: Record<string, Set<string>> = {
  rollout: new Set(["status", "history"]),
  auth: new Set(["can-i", "whoami"]),
  config: new Set(["current-context", "get-contexts"]),
};

const KUBECTL_VALUE_FLAGS = new Set([
  "-n", "--namespace", "--kubeconfig", "--context", "--cluster", "--user", "-s",
  "--server", "--as", "--request-timeout", "--token", "-o", "--output", "-l", "--selector",
]);

export function checkKubectl(
  cmd: string,
  approvedRunbooks: ApprovedRunbookEntry[] = [],
): string | null {
  if (!cmd.includes("kubectl")) return null;
  const segments = splitShellSegments(cmd);
  for (const seg of segments) {
    if (!seg.includes("kubectl")) continue;
    const toks = splitShellTokens(seg);
    if (!toks) {
      return "物理保险丝：kubectl 命令无法安全解析，禁止自动执行。";
    }
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i].replace(/^[$`(\s]+/, "");
      if (tok !== "kubectl" && !tok.endsWith("/kubectl")) continue;

      if (toks.slice(i + 1).some(a => a === "--raw" || a.startsWith("--raw="))) {
        return "安全护栏：禁止 kubectl --raw 直接访问 API（含 secret）。";
      }
      const words: string[] = [];
      let skipNext = false;
      for (let j = i + 1; j < toks.length; j++) {
        const a = toks[j];
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (KUBECTL_VALUE_FLAGS.has(a)) {
          skipNext = true;
          continue;
        }
        if (a.startsWith("-")) continue;
        words.push(a);
      }
      if (words.length === 0) continue;

      // Permanent redline: NEVER allow secret access even via Runbook!
      for (const w of words.slice(1)) {
        for (const p of w.split(",")) {
          if (/^secrets?(\/|$|\.)/i.test(p.trim())) {
            return "物理保险丝：kubectl 读取 secret 资源，禁止自动执行。";
          }
        }
      }

      const verb = words[0];
      if (verb === "port-forward") return "安全护栏：禁止 kubectl port-forward 建立集群隧道。";
      const sub = words[1] ?? "";
      const isReadonly =
        verb in KUBECTL_READ_SUB ? KUBECTL_READ_SUB[verb].has(sub) : KUBECTL_READ_VERBS.has(verb);
      if (!isReadonly) {
        if (approvedRunbooks.length > 0 && segments.length === 1 && !/[|;&`\n\r<>]|\$\(/.test(cmd)) {
          const normCur = normalizeKubectlTokens(toks.slice(i));
          if (
            normCur &&
            i === 0 &&
            approvedRunbooks.some((rb) =>
              rb.actions.kubectl_commands.some((allowed) => {
                const allowedToks = tokenizeSimpleShellCommand(allowed);
                const normAllowed = allowedToks ? normalizeKubectlTokens(allowedToks) : null;
                return normAllowed !== null && JSON.stringify(normAllowed) === JSON.stringify(normCur);
              }),
            )
          ) {
            continue;
          }
        }
        const label = verb in KUBECTL_READ_SUB ? `kubectl ${verb} ${sub}` : `kubectl ${verb}`;
        return `物理保险丝：${label} 属于非只读集群操作，禁止自动执行（如需发版变更，请先创建 Runbook 登记精确命令并由用户在对话中回复「批准 <runbook_id>」）。`;
      }
    }
  }
  return null;
}

export function checkCloudAndRedisOps(cmd: string, patterns: string[] = []): string | null {
  for (const pattern of patterns) {
    if (new RegExp(pattern, "i").test(cmd)) return "安全护栏：命令命中 guard.custom_block_patterns。";
  }
  if (/\bredis-cli\b/i.test(cmd) && /\b(flushdb|flushall|config\s+set|shutdown)\b/i.test(cmd)) {
    return "物理保险丝：禁止执行破坏性 Redis 命令（FLUSHDB/FLUSHALL/CONFIG SET/SHUTDOWN）。";
  }
  return null;
}
