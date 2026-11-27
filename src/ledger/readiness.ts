import { existsSync } from "node:fs";
import { canonicalRepoPath } from "../config";
import { isOid } from "../git";
import { installedInstance, verificationPolicy } from "../workflow-config";
import type { TaskReader } from "./queries";
import { deploymentStages } from "./release-inspection";
import { checkReviewReadiness } from "./review-readiness";
import { getSpecState } from "./spec";
import {
  evidenceSource,
  EXECUTABLE_EVIDENCE,
  isRolloutEndpoint,
  usesV05,
  type EvidenceSource,
} from "./types";

export interface ReadinessParams {
  task_id: string;
  repo: string;
  head_sha: string;
  branch?: string;
  checkoutDir?: string;
  checkEndpoint?: boolean;
  requireDeploymentCi?: boolean;
}

export function checkReadiness(ledger: TaskReader, params: ReadinessParams, closing: boolean) {
  const task = ledger.getTask(params.task_id);
  if (!task) {
    return {
      ready: false,
      missing: [`Task ${params.task_id} not found`],
      hasExplicitFailure: false,
      recordedReviewRoles: [],
    };
  }

  const missing: string[] = [];
  let hasExplicitFailure = false;
  const openBlockers = ledger.getTaskBlockers(params.task_id).filter(
    (b) => b.status === "OPEN",
  );
  if (openBlockers.length > 0) {
    missing.push(
      `${openBlockers.length} open blocker(s): ${openBlockers.map((b) => b.blocker_id).join(", ")}`,
    );
  }

  params = {...params, repo:canonicalRepoPath(ledger.workbenchRoot,params.repo)};
  const currentWorkflow = usesV05(ledger, params.task_id);
  const config = currentWorkflow ? installedInstance(ledger.workbenchRoot) : undefined;
  const rolloutStages = currentWorkflow && isRolloutEndpoint(task.endpoint) ? deploymentStages(config, task.endpoint) : [];
  const customVerification = config && (config.verification.source !== "core" ||
    config.verification.value.stages.some(id => config.stages.get(id)?.source !== "core"));
  const repoAttachments = ledger.getTaskRepos(params.task_id).filter((r) => r.repo === params.repo);
  const attachments = repoAttachments.filter((r) =>
    params.branch
      ? r.branch === params.branch
      : repoAttachments.length === 1 || r.head_sha === params.head_sha,
  );
  const registeredTree = attachments.length === 1 ? attachments[0].worktree : undefined;
  const policyCheckout = params.checkoutDir ?? (registeredTree && existsSync(registeredTree) ? registeredTree : undefined);
  const expectedPolicy = config ? verificationPolicy(ledger.workbenchRoot, params.repo, params.head_sha, config, policyCheckout) : undefined;
  const specState = getSpecState(ledger, params.task_id, { delivery: params, closing });
  if (currentWorkflow && specState.state === "NONE") missing.push("A confirmed frozen specification is required for delivery");
  if (specState.drifted_locked_tests.length) {
    hasExplicitFailure = true;
    missing.push("冻结测试文件发生漂移 (" + specState.drifted_locked_tests.join(", ") + ")，请恢复测试文件或执行 forge ledger amend " + params.task_id + " --scope test_spec --reason <原因> 后重新运行 forge ledger freeze " + params.task_id);
  }
  if (specState.state === "AMENDED") {
    missing.push(
      `spec is in AMENDED state (scope=${specState.amend_scope ?? "unknown"}); finish revisions and run \`forge ledger freeze ${params.task_id}\` before delivery`,
    );
  } else if (specState.state === "FROZEN" && specState.drifted_files.length > 0) {
    hasExplicitFailure = true;
    missing.push(
      `frozen spec drifted on disk (${specState.drifted_files.join(", ")}); restore files or run \`forge ledger amend ${params.task_id} --scope ... --reason "..."\` then re-freeze`,
    );
  }

  const review = attachments.length === 1
    ? checkReviewReadiness(ledger, attachments[0], params.head_sha, specState, policyCheckout)
    : { roles: [], failed: false, missing: "Specify one attached branch to verify delivery evidence" };
  const floors = specState.evidence_floor_seq;
  const events = ledger.db
    .query(
      `SELECT seq, actor, branch, sha, event_type, payload_json FROM events
       WHERE task_id = ? AND canonical_repo(repo) = canonical_repo(?)
         AND (event_type IN ('REPO_ATTACHED','REPO_DETACHED') OR (event_type='EVIDENCE_CAPTURED' AND sha=?))
       ORDER BY seq ASC`,
    )
    .all(params.task_id, params.repo, params.head_sha) as Array<{
    seq: number;
    event_type: string;
    branch: string | null;
    sha: string | null;
    actor: string;
    payload_json: string;
  }>;

  type BranchEvidence = {
    checks: Map<string, string>;
    endpoint?: string;
  };
  const byBranch = new Map<string | null, BranchEvidence>();
  const attachedAtEvent = new Set<string>();
  for (const ev of events) {
    if (ev.event_type === "REPO_ATTACHED" || ev.event_type === "REPO_DETACHED") {
      if (ev.branch) {
        if (ev.event_type === "REPO_ATTACHED") attachedAtEvent.add(ev.branch);
        else attachedAtEvent.delete(ev.branch);
      }
      continue;
    }
    const branch = ev.branch ?? (attachedAtEvent.size === 1 ? attachedAtEvent.keys().next().value ?? null : null);
    if (params.branch && branch && branch !== params.branch) continue;
    let evidence = byBranch.get(branch);
    if (!evidence) {
      evidence = { checks: new Map() };
      byBranch.set(branch, evidence);
    }
    try {
      const p = JSON.parse(ev.payload_json) as {
        source?: EvidenceSource;
        kind?: string;
        status?: string;
        meta?: {
          stage_receipts?: { stage: string; state: string; endpoint: string; versions: { repo: string; head: string }[] }[];
          pr_head_oid?: string;
          state?: string; base_branch?: string; target_oid?: string;
          pr_url?: string;
          policy_sha256?: string; startup_failure?: boolean; delivery_endpoint?: string;
          mode?: string; freeze_seq?: number; review_task_id?: string;
        };
      };
      if (!p.kind || !p.status) continue;
      if (EXECUTABLE_EVIDENCE.has(p.kind) && evidenceSource(p, ev.actor) === "manual") continue;
      if (currentWorkflow && p.kind === "verify" && p.meta?.mode === "all" &&
          p.meta.review_task_id === params.task_id && p.meta.freeze_seq === specState.freeze_seq &&
          ((p.status === "fail" && p.meta.startup_failure === true) ||
           (expectedPolicy !== undefined && expectedPolicy === p.meta.policy_sha256)) &&
          evidenceSource(p, ev.actor) === "tool" && ev.seq >= Math.max(floors.lint, floors.test)) {
        evidence.checks.set("verify", p.status);
      }
      if (p.kind === "lint") {
        if (ev.seq >= floors.lint) evidence.checks.set("lint", p.status);
      } else if (p.kind === "test" || p.kind === "build") {
        if (ev.seq >= floors.test) evidence.checks.set(p.kind, p.status);
      } else if (p.kind === "hurl") {
        if (ev.seq >= floors.test) evidence.checks.set("hurl", p.status);
      }
      if (
        (task.endpoint === "pr" && p.kind === "pr" && attachments.length === 1 && ev.branch === attachments[0].branch) ||
        (task.endpoint === "fat" && !rolloutStages.length && (p.kind === "fat" ||
          (p.kind === "hurl" && evidenceSource(p, ev.actor) === "hook"))) ||
        (isRolloutEndpoint(task.endpoint) && p.kind === "prod" && (task.endpoint === "prod" ||
          (evidenceSource(p, ev.actor) === "tool" && p.meta?.delivery_endpoint === task.endpoint)))
      ) {
        if (currentWorkflow && p.kind === "prod" && p.status === "pass" && task.endpoint !== "prod" &&
            config?.delivery.value.endpoint !== task.endpoint) continue;
        if (p.kind === "prod" && p.status === "pass" && rolloutStages.length &&
            (evidenceSource(p, ev.actor) !== "tool" || p.meta?.delivery_endpoint !== task.endpoint ||
             !rolloutStages.every(id => p.meta?.stage_receipts?.some(receipt => receipt.stage === id &&
               receipt.state === "completed" && receipt.endpoint === task.endpoint &&
               receipt.versions.some(version => version.repo === params.repo && version.head === params.head_sha))))) continue;
        if (p.kind === "pr" && p.status === "pass" &&
            (p.meta?.pr_head_oid !== params.head_sha || !p.meta.pr_url)) continue;
        if (currentWorkflow && p.kind==="pr" && p.status==="pass") {
          if (evidenceSource(p,ev.actor)!=="tool") continue;
          if (p.meta?.state!=="MERGED" || p.meta.base_branch!=="main" || !isOid(p.meta.target_oid??"")) {
            evidence.endpoint=undefined;
            continue;
          }
        }
        const endpointFloor = task.endpoint === "fat" && !rolloutStages.length ? floors.fat : 0;
        if (ev.seq >= endpointFloor && (p.status === "pass" || p.status === "fail")) {
          evidence.endpoint = p.status;
        }
      }
    } catch {
      // Ignore malformed payload
    }
  }

  // A detached merge must honor failures at its own SHA before trying a verified parent.
  // Positive evidence is credited only to the selected attachment or its unambiguous legacy receipts.
  const failedKinds = new Set<string>();
  const latestByKind = new Map<string, string>();
  let latestEndpointStatus: string | undefined;
  for (const [branch, evidence] of byBranch) {
    const eligible = attachments.length === 1 && branch === attachments[0].branch;
    for (const [kind, status] of evidence.checks) {
      if (status === "fail") failedKinds.add(kind);
      if (eligible && status === "pass") latestByKind.set(kind, status);
    }
    if (evidence.endpoint === "fail" || (eligible && latestEndpointStatus !== "fail" && evidence.endpoint)) {
      latestEndpointStatus = evidence.endpoint;
    }
  }
  const hasPassingVerify = [...latestByKind.values()].some((st) => st === "pass");
  const hasPassingExecVerify =
    latestByKind.get("test") === "pass" ||
    (!currentWorkflow && latestByKind.get("build") === "pass") ||
    latestByKind.get("hurl") === "pass";

  if (failedKinds.size > 0) {
    hasExplicitFailure = true;
    missing.push(
      `latest ${[...failedKinds].join("/")} failed for ${params.repo}@${params.head_sha.slice(0, 8)}`,
    );
  } else if (currentWorkflow && latestByKind.get("verify") === "pass") {
    // The configured verification sequence completed at this freeze and SHA.
  } else if (customVerification) {
    missing.push("Missing completed verification for the configured environment and stages");
  } else if (currentWorkflow || task.verification_depth === "full") {
    if (latestByKind.get("lint") !== "pass") {
      missing.push(
        `full verification requires passing static check (lint) evidence for ${params.repo}@${params.head_sha.slice(0, 8)} (run .workbench/bin/forge verify --task ${params.task_id} --repo ${params.repo} --mode static)`,
      );
    }
    if (!hasPassingExecVerify) {
      const checks = currentWorkflow ? "executed test" : "build/test/hurl";
      missing.push(
        `no passing ${checks} evidence recorded for ${params.repo}@${params.head_sha.slice(0, 8)}`,
      );
    }
  } else if (!hasPassingVerify) {
    missing.push(
      `no passing build/test/lint/hurl evidence recorded for ${params.repo}@${params.head_sha.slice(0, 8)}`,
    );
  }

  if (params.requireDeploymentCi && latestByKind.get("verify") !== "pass" &&
      !(latestByKind.get("lint") === "pass" &&
        (latestByKind.get("test") === "pass" || latestByKind.get("hurl") === "pass"))) {
    missing.push("Production CI requires passing configured verification or static and executed test receipts for " +
      params.repo + "@" + params.head_sha);
  }

  if (review.missing) missing.push(review.missing);
  hasExplicitFailure ||= review.failed;

  if (
    params.checkEndpoint &&
    (task.endpoint === "pr" || task.endpoint === "fat" || isRolloutEndpoint(task.endpoint))
  ) {
    const syncPr = `forge ledger pr-sync ${params.task_id} --repo ${params.repo}`;
    const prHint = task.endpoint !== "pr" ? "" : currentWorkflow
      ? `; after the PR is merged into remote main, run ${syncPr} --branch ${attachments.length === 1 ? Bun.$.escape(attachments[0].branch) : "<attached-branch>"} --pr <number-or-url> to verify the merged revision. After local branch deletion, the recorded head must remain reachable from the origin feature or default-branch tracking ref`
      : `; run ${syncPr} to verify the remote PR head`;
    if (latestEndpointStatus === "fail") {
      hasExplicitFailure = true;
      missing.push(
        `latest ${task.endpoint} delivery verification failed for ${params.repo}@${params.head_sha.slice(0, 8)}` + (currentWorkflow ? prHint : ""),
      );
    } else if (latestEndpointStatus !== "pass") {
      missing.push(
        `endpoint "${task.endpoint}" requires recorded ${task.endpoint} delivery evidence for ${params.repo}@${params.head_sha.slice(0, 8)}` +
        prHint,
      );
    }
  }

  return {
    ready: missing.length === 0,
    missing,
    hasExplicitFailure,
    recordedReviewRoles: review.roles,
  };
}
