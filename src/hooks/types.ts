export interface CapturedEvidence {
  kind: "commit" | "build" | "test" | "lint" | "review" | "hurl" | "pr";
  status: "pass" | "fail" | "fallback";
  summary: string;
  targetDir: string;
  targetBranch?: string | null;
  targetOwner?: string | null;
  targetRepoSpec?: string | null;
  targetHost?: string | null;
  prUrl?: string;
  ghEnv?: Record<string, string>;
  prUrlRepoSpec?: string | null;
  pinnedSha?: string | null;
  pinnedRef?: string | null;
  requirePinnedSha?: boolean;
  meta?: Record<string, unknown>;
}

export const BENIGN_TRAILING_CMDS = new Set([
  "cd",
  "echo",
  "printf",
  "true",
  "pwd",
  "date",
  "ls",
  "wc",
  "cat",
  "head",
  "tail",
  "stat",
  ":",
]);

export type ScriptKind = "test" | "lint" | "build";

export type VerificationHit = {
  kind: "test" | "build" | "lint" | "hurl" | "lang-check";
  cmdToks: string[];
  envToks: string[];
};

export type ReportPhase = { kind: "lint" | "test"; status: "pass" | "fail" };

/**
 * Shell builtins / keywords that can terminate the shell early, flip exit codes,
 * change directories outside `cd`, or redefine commands/environment mid-chain.
 */
export const SHELL_CONTROL_OR_STATE_BUILTINS = new Set([
  "!",
  "coproc",
  "exit",
  "exec",
  "return",
  "logout",
  "suspend",
  "kill",
  "eval",
  "source",
  ".",
  "alias",
  "unalias",
  "enable",
  "builtin",
  "command",
  "function",
  "trap",
  "set",
  "shopt",
  "export",
  "unset",
  "declare",
  "typeset",
  "local",
  "readonly",
  "hash",
  "pushd",
  "popd",
  "break",
  "continue",
]);
