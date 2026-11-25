export interface CapturedEvidence {
  kind: "commit" | "pr";
  status: "pass" | "fail";
  summary: string;
  targetDir: string;
  targetBranch?: string | null;
  targetOwner?: string | null;
  targetRepoSpec?: string | null;
  targetHost?: string | null;
  prUrl?: string;
  ghEnv?: Record<string, string>;
  prUrlRepoSpec?: string | null;
  meta?: Record<string, unknown>;
}
