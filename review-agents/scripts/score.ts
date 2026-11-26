import type { validateReport } from "../src/report";

type Finding = ReturnType<typeof validateReport>["findings"][number];

export function matchesDefect(sample: {line: number; concepts: string[]; after: string}, finding: Finding) {
  if (finding.severity !== "blocking" || finding.path !== "sample.ts" || finding.line !== sample.line) return false;
  // Quoting the changed line supplies location but cannot supply the diagnosis.
  const code = sample.after.split("\n")[sample.line - 1];
  const explanation = [finding.title, finding.evidence, finding.recommendation]
    .map(text => text.replaceAll(code, "")).join(" ");
  return sample.concepts.every(concept => new RegExp(concept, "iu").test(explanation));
}
