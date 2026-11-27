import { splitShellTokens } from "./shared/shell";

export function isPytestInfoSwitch(arg: string) {
  return /^-[qvsxl]*[Vh]/.test(arg);
}

// Keep only runner signals. A large suite can interleave arbitrary output
// between the test count, its failures, and delegated runners' summaries.
export class TestRunSummary {
  private readonly seen = new Set<string>();
  observe = (text: string) => {
    const signals: Record<string, RegExp> = testSignals;
    for (const name in signals) {
      if (!this.seen.has(name) && signals[name].test(text)) this.seen.add(name);
    }
    for (const line of text.split("\n")) {
      const cargo = /^\s*(?:test result: [^\n]*?\b)?(\d+)\s+passed;\s*(\d+)\s+failed\b/.exec(line);
      if (cargo) this.seen.add(Number(cargo[1]) + Number(cargo[2]) ? "cargoRan" : "cargoEmpty");
      if (/^(?:ok\s|\?\s)/.test(line) && /\[no (?:test files|tests to run)\]\s*$/.test(line))
        this.seen.add("goSkip");
      else if (/^ok\s+\S|^\s*--- PASS:/.test(line)) this.seen.add("goRan");
      if (!line.startsWith("{") || !line.includes('"Package"')) continue;
      try {
        const event = JSON.parse(line);
        if (typeof event.Package !== "string") continue;
        if (event.Action === "pass" && event.Test) this.seen.add("goRan");
        if (event.Action === "skip" || /\[no (?:test files|tests to run)\]\s*$/.test(event.Output ?? ""))
          this.seen.add("goSkip");
      } catch { /* Other delegated output can look like JSON. */ }
    }
  };

  skipped(bin: string, code: number) {
    const has = (key: string) => this.seen.has(key);
    const delegated = bin === "bun";
    if (bin === "pytest" || (delegated && (has("collected") || has("pytestInfo") || has("pytest")))) {
      if (code === 5) return true;
      if (code !== 0) return false;
      const options = splitShellTokens(process.env.PYTEST_ADDOPTS ?? "");
      if (has("pytestInfo") && !has("passed") && !has("pass")) return true;
      if (!options || options.some(a => nonExecutingPytest.has(a.split("=")[0]) || isPytestInfoSwitch(a)) || has("collected")) return true;
    }
    if (code !== 0) return delegated && code === 5 && has("noTests");
    if (bin === "cargo" || delegated) {
      if (has("cargoRan") || has("cargoEmpty")) return !has("cargoRan");
      if (has("running") || has("runningZero")) return !has("running");
    }
    if (delegated && (has("nodeZero") || (has("nodeNoPass") && has("nodeNoFail")))) return true;
    if (bin === "go" || (delegated && (has("goRan") || has("goSkip")))) return !has("goRan");
    return delegated && !has("pass") && ((has("bunNoPass") && has("bunNoFail")) || has("empty"));
  }
}

const nonExecutingPytest = new Set(["--collect-only", "--collectonly", "--co", "--setup-only", "--setuponly",
  "--setup-plan", "--setupplan", "--markers", "--fixtures", "--funcargs", "--fixtures-per-test", "--version", "--help", "-V", "-h"]);
const testSignals = {
  collected: /^\s*(?:=+\s*)?(?:no|\d+(?:\/\d+)?)\s+tests?\s+collected(?:\s+in|\s+\(|\s*=+\s*$|\s*$)/im,
  pytestInfo: /^(?:This is pytest version \S+, imported from .+|pytest \d+\.\d+\S*|usage: (?:pytest|py\.test) \[options\].*)$/m,
  pytest: /^>\s+[^\n]*\bpytest\b|^platform .+ -- Python .+pytest-/m,
  passed: /^\s*(?:=+\s*)?\d+ passed\b/m,
  pass: /^\s*[1-9]\d* pass\s*$/m,
  noTests: /no tests (?:ran|collected)/i,
  running: /^\s*running [1-9]\d* tests?\b/m,
  runningZero: /^\s*running 0 tests\b/m,
  nodeZero: /^# tests 0\s*$/m,
  nodeNoPass: /^# pass 0\s*$/m,
  nodeNoFail: /^# fail 0\s*$/m,
  bunNoPass: /^\s*0 pass\s*$/m,
  bunNoFail: /^\s*0 fail\s*$/m,
  empty: /^\s*(?:Ran\s+)?0 tests?(?: across \d+ files?\.?)?\s*$/im,
};
