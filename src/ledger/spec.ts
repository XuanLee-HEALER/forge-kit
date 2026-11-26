import { usesV05 } from "./types";
import { canonicalRepoPath } from "../config";
import { scanLockedTests } from "./locked-tests";
import { appendEventInTx, withImmediateTx } from "./transactions";
import {
  type EventRecord,
  type LedgerReader,
  type LockedGitlinks,
  type SpecAmendedPayload,
  type SpecAmendScope,
  type SpecFrozenPayload,
  type TaskSpecState,
} from "./types";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { matchesGlob, sha256File } from "../shared/path";

export const SPEC_AMEND_STALE_MAP: Record<SpecAmendScope, string[]> = {
  requirement: ["ssot", "tech_spec", "test_spec", "lint", "test", "review", "fat"],
  invariant: ["tech_spec", "test_spec", "lint", "test", "review", "fat"],
  tech_spec: ["lint", "test", "review", "fat"],
  test_spec: ["test", "fat"],
};

const VALID_SPEC_AMEND_SCOPES = new Set<string>([
  "requirement",
  "invariant",
  "tech_spec",
  "test_spec",
]);

function readFrozenPayload(root:string, json:string) {
  const payload = JSON.parse(json) as Partial<SpecFrozenPayload>;
  const relativeKey = (path:string) => relative(resolve(root),resolve(root,path));
  const repos=Object.keys(payload.locked_test_revisions ?? {}).map(relativeKey).sort((a,b)=>b.length-a.length);
  for (const field of ["locked_test_files","locked_test_blobs","locked_test_modes","tracked_locked_tests","locked_test_revisions","locked_gitlinks"] as const) {
    const map = payload[field];
    if (!map) continue;
    for (const key of Object.keys(map)) {
      let normalized: string;
      if (field === "locked_gitlinks") {
        const [repo,path,oid] = JSON.parse(key);
        normalized = JSON.stringify([canonicalRepoPath(root,repo),path,oid]);
      } else if (field === "locked_test_revisions") normalized=canonicalRepoPath(root,key);
      else {
        normalized=relativeKey(key);
        const repo=repos.find(r=>normalized.startsWith(r+"/"));
        if(repo) normalized=canonicalRepoPath(root,repo)+normalized.slice(repo.length);
      }
      if (normalized !== key) {
        map[normalized] = map[key];
        delete map[key];
      }
    }
  }
  return payload;
}

export function freezeSpec(ledger: LedgerReader, params: {
  task_id: string;
  spec_dir?: string;
  locked_test_globs?: string[];
  actor?: string;
  session_id?: string | null;
}): { event: EventRecord; spec: TaskSpecState } {
  const ev = withImmediateTx(ledger.db, () => {
    const task = ledger.getTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    if (task.status !== "OPEN") {
      throw new Error(`Cannot freeze spec on ${task.status} task ${params.task_id}`);
    }

    const wbReal = realpathSync(ledger.workbenchRoot);
    const rawDir = params.spec_dir?.trim() || join(".workbench", "specs", params.task_id);
    const absDir = resolve(wbReal, rawDir);
    if (!existsSync(absDir)) {
      throw new Error(`Spec directory does not exist: ${rawDir}`);
    }
    const realDir = realpathSync(absDir);
    if (!statSync(realDir).isDirectory()) {
      throw new Error(`Spec path is not a directory: ${rawDir}`);
    }
    const relDir = relative(wbReal, realDir).replace(/\\/g, "/");
    if (!relDir || relDir.startsWith("..") || isAbsolute(relDir)) {
      throw new Error(`Spec directory must reside inside workbench root: ${rawDir}`);
    }

    const previous = ledger.getSpecState(params.task_id);
    const lightweight = previous.files ? Object.hasOwn(previous.files, "scope")
      : task.verification_depth === "targeted" && usesV05(ledger, params.task_id);
    const fileNames: Record<string, string> = lightweight ? { scope: "scope.md" }
      : { ssot: "ssot.md", tech_spec: "tech-spec.md", test_spec: "test-spec.md" };
    const files: Record<string, string> = {};
    const hashes: Record<string, string> = {};
    for (const [key, fname] of Object.entries(fileNames)) {
      files[key] = relDir + "/" + fname;
      const absFile = join(realDir, fname);
      if (!existsSync(absFile)) {
        throw new Error(`Missing required spec document: ${files[key]}`);
      }
      const realFile = realpathSync(absFile);
      if (!statSync(realFile).isFile()) {
        throw new Error(`Spec document is not a regular file: ${files[key]}`);
      }
      const relToSpecDir = relative(realDir, realFile).replace(/\\/g, "/");
      if (!relToSpecDir || relToSpecDir.startsWith("..") || isAbsolute(relToSpecDir)) {
        throw new Error(
          `Spec document resolves outside selected spec directory (${relDir}): ${files[key]}`,
        );
      }
      const rawText = readFileSync(realFile, "utf8");
      if (!rawText.trim()) {
        throw new Error(`Spec document is empty: ${files[key]}`);
      }
      const digest = sha256File(realFile);
      if (!digest) {
        throw new Error(`Failed to hash spec document: ${files[key]}`);
      }
      hashes[key] = digest;
    }

    const prevSpec = previous;
    const lockedGlobs =
      params.locked_test_globs !== undefined
        ? [...new Set(params.locked_test_globs.map((g) => g.trim()).filter(Boolean))]
        : prevSpec.locked_test_globs;

    if (prevSpec.state === "FROZEN") {
      if (prevSpec.spec_dir && relDir !== prevSpec.spec_dir) {
        throw new Error(
          `Cannot change spec_dir from ${prevSpec.spec_dir} to ${relDir} while spec is FROZEN; run \`ledger amend ${params.task_id} --scope requirement --reason "..."\` first`,
        );
      }
      const changedDocs: string[] = [];
      for (const key of Object.keys(files)) {
        if (prevSpec.hashes && hashes[key] !== prevSpec.hashes[key]) {
          changedDocs.push(files[key]);
        }
      }
      if (changedDocs.length > 0) {
        throw new Error(
          `Cannot re-freeze drifted spec document(s) (${changedDocs.join(", ")}) without an explicit amendment; restore files or run \`ledger amend ${params.task_id} --scope ... --reason "..."\` first`,
        );
      }
      if (params.locked_test_globs !== undefined) {
        const dropped = prevSpec.locked_test_globs.filter((g) => !lockedGlobs.includes(g));
        if (dropped.length > 0) {
          throw new Error(
            `Cannot remove locked test glob(s) (${dropped.join(", ")}) while spec is FROZEN; run \`ledger amend ${params.task_id} --scope test_spec --reason "..."\` first`,
          );
        }
      }
    } else if (prevSpec.state === "AMENDED") {
      const scopes = new Set<SpecAmendScope>(prevSpec.amend_scopes);
      const allowSsot = scopes.has("requirement") || scopes.has("invariant");
      const allowTech = allowSsot || scopes.has("tech_spec");
      const allowTest = allowSsot || scopes.has("test_spec");
      if (!allowSsot && prevSpec.spec_dir && relDir !== prevSpec.spec_dir) {
        throw new Error(
          `Cannot change spec_dir from ${prevSpec.spec_dir} to ${relDir} outside requirement/invariant amend scope`,
        );
      }
      const unauthorizedDocs: string[] = [];
      if (!allowSsot && prevSpec.hashes && hashes.ssot !== prevSpec.hashes.ssot) {
        unauthorizedDocs.push(files.ssot);
      }
      if (!allowTech && prevSpec.hashes && hashes.tech_spec !== prevSpec.hashes.tech_spec) {
        unauthorizedDocs.push(files.tech_spec);
      }
      if (!allowTest && prevSpec.hashes && hashes.test_spec !== prevSpec.hashes.test_spec) {
        unauthorizedDocs.push(files.test_spec);
      }
      if (unauthorizedDocs.length > 0) {
        throw new Error(
          `Cannot re-freeze: out-of-scope spec document(s) changed (${unauthorizedDocs.join(", ")}) outside amend scope(s) [${[...scopes].join(", ")}]; restore them or add an authorizing \`ledger amend\``,
        );
      }
      if (!scopes.has("test_spec") && !scopes.has("invariant") && params.locked_test_globs !== undefined) {
        const dropped = prevSpec.locked_test_globs.filter((g) => !lockedGlobs.includes(g));
        if (dropped.length > 0) {
          throw new Error(
            `Cannot remove locked test glob(s) (${dropped.join(", ")}) outside test_spec/invariant amend scope`,
          );
        }
      }
    }

    if (prevSpec.drifted_locked_tests.length) {
      throw new Error("冻结测试文件发生漂移 (" + prevSpec.drifted_locked_tests.join(", ") + ")，请恢复测试文件或执行 ledger amend --scope test_spec 后重新 freeze");
    }
    const testsUnlocked = prevSpec.amend_scopes.some(scope => scope === "test_spec" || scope === "invariant");
    const snapshot = scanLockedTests(ledger, params.task_id, lockedGlobs, { amendedSnapshot: testsUnlocked });
    const activeRepos = new Set(ledger.getTaskRepos(params.task_id).map(r => r.repo));
    if (prevSpec.freeze_seq !== null) {
      const row = ledger.db.query("SELECT payload_json FROM events WHERE task_id = ? AND seq = ?")
        .get(params.task_id, prevSpec.freeze_seq) as { payload_json: string };
      const prior = readFrozenPayload(ledger.workbenchRoot,row.payload_json);
      for (const [key, hash] of Object.entries(prior.locked_test_files ?? {})) {
        const slash = key.indexOf("/");
        if (activeRepos.has(key.slice(0, slash)) || !lockedGlobs.some(g => matchesGlob(key.slice(slash + 1), g))) continue;
        snapshot.files[key] = hash;
        for (const [target, source] of [[snapshot.blobs, prior.locked_test_blobs], [snapshot.modes, prior.locked_test_modes],
          [snapshot.tracked, prior.tracked_locked_tests]] as const) {
          if (source?.[key] !== undefined) target[key] = source[key];
        }
      }
      for (const [repo, refs] of Object.entries(prior.locked_test_revisions ?? {}))
        if (!activeRepos.has(repo)) snapshot.revisions[repo] = refs;
      for (const [key, entries] of Object.entries(prior.locked_gitlinks ?? {})) {
        if (!activeRepos.has(JSON.parse(key)[0])) snapshot.gitlinks[key] = entries;
      }
    }
    for (const glob of lockedGlobs) {
      if (!/[*?]/.test(glob) && !Object.keys(snapshot.files).some(key => matchesGlob(key.slice(key.indexOf("/") + 1), glob))) {
        throw new Error("Cannot freeze requested test path: " + glob);
      }
    }
    if (snapshot.drift.length) throw new Error("冻结测试文件与 Git HEAD 不一致或不是普通文件: " + snapshot.drift.join(", "));
    if (prevSpec.locked_test_globs.length && !testsUnlocked) {
      // Validate the actual snapshot we are about to persist, including additions under an already frozen glob.
      const activeRepos = ledger.getTaskRepos(params.task_id).map(r => r.repo + "/");
      for (const key of new Set([...Object.keys(prevSpec.locked_test_files), ...Object.keys(snapshot.files)])) {
        if (!activeRepos.some(prefix => key.startsWith(prefix))) continue;
        const rel = key.slice(key.indexOf("/") + 1);
        if (prevSpec.locked_test_globs.some(glob => matchesGlob(rel, glob)) &&
            prevSpec.locked_test_files[key] !== snapshot.files[key]) {
          throw new Error("冻结测试文件发生漂移: " + key);
        }
      }
    }
    const payload: SpecFrozenPayload = {
      spec_dir: relDir,
      files,
      hashes,
      locked_test_globs: lockedGlobs,
      locked_test_files: snapshot.files,
      locked_test_modes: snapshot.modes,
      locked_test_blobs: snapshot.blobs,
      locked_gitlinks: snapshot.gitlinks,
      locked_test_revisions: snapshot.revisions,
      tracked_locked_tests: snapshot.tracked,
    };
    return appendEventInTx(ledger.db, {
      task_id: params.task_id,
      event_type: "SPEC_FROZEN",
      actor: params.actor ?? "agent",
      session_id: params.session_id,
      payload: payload as unknown as Record<string, unknown>,
    });
  });

  return { event: ev, spec: ledger.getSpecState(params.task_id) };
}

export function amendSpec(ledger: LedgerReader, params: {
  task_id: string;
  scope: SpecAmendScope;
  reason: string;
  actor?: string;
  session_id?: string | null;
}): { event: EventRecord; spec: TaskSpecState } {
  if (!VALID_SPEC_AMEND_SCOPES.has(params.scope)) {
    throw new Error(
      `Invalid amend scope: ${params.scope}. Must be one of: requirement, invariant, tech_spec, test_spec`,
    );
  }
  if (!params.reason?.trim()) {
    throw new Error("ledger amend requires a non-empty --reason");
  }

  const ev = withImmediateTx(ledger.db, () => {
    const task = ledger.getTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    if (task.status !== "OPEN") {
      throw new Error(`Cannot amend spec on ${task.status} task ${params.task_id}`);
    }
    const cur = getSpecState(ledger, params.task_id, { metadataOnly: true });
    if (cur.state === "NONE") {
      throw new Error(`Task ${params.task_id} has no frozen spec yet; run ledger freeze first`);
    }

    const payload: SpecAmendedPayload = {
      scope: params.scope,
      reason: params.reason.trim(),
      stale_stages: [...SPEC_AMEND_STALE_MAP[params.scope]],
    };
    return appendEventInTx(ledger.db, {
      task_id: params.task_id,
      event_type: "SPEC_AMENDED",
      actor: params.actor ?? "agent",
      session_id: params.session_id,
      payload: payload as unknown as Record<string, unknown>,
    });
  });

  return { event: ev, spec: ledger.getSpecState(params.task_id) };
}

export function getSpecState(ledger: LedgerReader, task_id: string, options: { metadataOnly?: boolean; closing?: boolean; delivery?: { repo: string; head_sha: string; checkoutDir?: string } } = {}): TaskSpecState {
  const rows = ledger.db
    .query(
      `SELECT seq, event_type, payload_json FROM events
         WHERE task_id = ? AND event_type IN ('SPEC_FROZEN', 'SPEC_AMENDED')
         ORDER BY seq ASC`,
    )
    .all(task_id) as Array<{ seq: number; event_type: string; payload_json: string }>;

  let freezeSeq: number | null = null;
  let amendSeq: number | null = null;
  let specDir: string | null = null;
  let files: Record<string, string> | null = null;
  let hashes: Record<string, string> | null = null;
  let lockedFiles: Record<string, string> | undefined;
  let gitlinks: LockedGitlinks = {};
  let freezeRefs: Record<string, string[]> = {};
  let frozenModes: Record<string, string> | undefined;
  let frozenOids: Record<string, string> = {};
  let trackedFiles: Record<string, string> = {};
  let lockedTestGlobs: string[] = [];
  let amendScope: SpecAmendScope | null = null;
  let amendReason: string | null = null;
  let firstFreezeSeen = false;
  let pendingAmendScopes = new Set<SpecAmendScope>();
  let pendingStaleStages = new Set<string>();
  const floors = { lint: 0, test: 0, review: 0, fat: 0 };

  for (const row of rows) {
    try {
      if (row.event_type === "SPEC_FROZEN") {
        const p = readFrozenPayload(ledger.workbenchRoot,row.payload_json);
        freezeSeq = row.seq;
        specDir = p.spec_dir ?? specDir;
        if (p.files) files = p.files;
        lockedFiles = p.locked_test_files;
        gitlinks = p.locked_gitlinks ?? {};
        freezeRefs = p.locked_test_revisions ?? {};
        frozenModes = p.locked_test_modes;
        frozenOids = p.locked_test_blobs ?? {};
        trackedFiles = p.tracked_locked_tests ?? {};
        if (p.hashes) hashes = p.hashes;
        if (Array.isArray(p.locked_test_globs)) {
          lockedTestGlobs = p.locked_test_globs.map(String);
        }
        if (!firstFreezeSeen) {
          firstFreezeSeen = true;
          floors.lint = Math.max(floors.lint, row.seq);
          floors.test = Math.max(floors.test, row.seq);
          floors.review = Math.max(floors.review, row.seq);
          floors.fat = Math.max(floors.fat, row.seq);
        } else {
          if (pendingStaleStages.has("lint")) floors.lint = Math.max(floors.lint, row.seq);
          if (pendingStaleStages.has("test")) floors.test = Math.max(floors.test, row.seq);
          if (pendingStaleStages.has("review")) floors.review = Math.max(floors.review, row.seq);
          if (pendingStaleStages.has("fat")) floors.fat = Math.max(floors.fat, row.seq);
        }
        pendingStaleStages = new Set<string>();
        pendingAmendScopes = new Set<SpecAmendScope>();
      } else if (row.event_type === "SPEC_AMENDED") {
        const p = JSON.parse(row.payload_json) as Partial<SpecAmendedPayload>;
        amendSeq = row.seq;
        if (p.scope && VALID_SPEC_AMEND_SCOPES.has(p.scope)) {
          amendScope = p.scope;
          pendingAmendScopes.add(p.scope);
        }
        amendReason = p.reason ?? null;
        for (const st of p.stale_stages ?? []) {
          pendingStaleStages.add(String(st));
        }
      }
    } catch {
      // Ignore malformed payload
    }
  }

  if (freezeSeq === null) {
    return {
      task_id,
      state: "NONE",
      freeze_seq: null,
      amend_seq: null,
      spec_dir: null,
      files: null,
      hashes: null,
      locked_test_globs: [],
      locked_test_files: {},
      drifted_locked_tests: [],
      drift_detected: false,
      amend_scope: null,
      amend_scopes: [],
      amend_reason: null,
      stale_stages: [],
      drifted_files: [],
      evidence_floor_seq: floors,
    };
  }

  const isAmended = amendSeq !== null && amendSeq > freezeSeq;
  const driftedFiles: string[] = [];
  if (!options.metadataOnly && !isAmended && files && hashes) {
    const wbReal = existsSync(ledger.workbenchRoot)
      ? realpathSync(ledger.workbenchRoot)
      : resolve(ledger.workbenchRoot);
    let realSpecDir: string | null = null;
    if (specDir) {
      const specDirAbs = resolve(wbReal, specDir);
      if (existsSync(specDirAbs)) {
        try {
          const candidateReal = realpathSync(specDirAbs);
          const relRealDir = relative(wbReal, candidateReal).replace(/\\/g, "/");
          if (
            statSync(candidateReal).isDirectory() &&
            relRealDir &&
            !relRealDir.startsWith("..") &&
            !isAbsolute(relRealDir) &&
            relRealDir === specDir
          ) {
            realSpecDir = candidateReal;
          }
        } catch {
          realSpecDir = null;
        }
      }
    }
    for (const key of Object.keys(files)) {
      const relPath = files[key];
      const expectedHash = hashes[key];
      const absFile = resolve(wbReal, relPath);
      if (!existsSync(absFile) || !realSpecDir) {
        driftedFiles.push(relPath);
        continue;
      }
      let realFile: string;
      try {
        realFile = realpathSync(absFile);
      } catch {
        driftedFiles.push(relPath);
        continue;
      }
      const relToDir = relative(realSpecDir, realFile).replace(/\\/g, "/");
      if (!relToDir || relToDir.startsWith("..") || isAbsolute(relToDir)) {
        driftedFiles.push(relPath);
        continue;
      }
      const actualHash = sha256File(realFile);
      if (!actualHash || actualHash !== expectedHash) {
        driftedFiles.push(relPath);
      }
    }
  }

  const unlocked = isAmended && (pendingAmendScopes.has("test_spec") || pendingAmendScopes.has("invariant"));
  const driftedTests = options.metadataOnly || unlocked || !lockedTestGlobs.length ? [] : lockedFiles
    ? scanLockedTests(ledger, task_id, lockedTestGlobs, { frozen: lockedFiles, frozenBlobs: trackedFiles,
        delivery: options.delivery, closing: options.closing, frozenModes, frozenOids, freezeRefs, gitlinks }).drift
    : ["legacy snapshot missing"];
  return {
    task_id,
    state: isAmended ? "AMENDED" : "FROZEN",
    freeze_seq: freezeSeq,
    amend_seq: amendSeq,
    spec_dir: specDir,
    files,
    hashes,
    locked_test_globs: lockedTestGlobs,
    locked_test_files: lockedFiles ?? {},
    drifted_locked_tests: driftedTests,
    drift_detected: Boolean(driftedTests.length || driftedFiles.length),
    amend_scope: isAmended ? amendScope : null,
    amend_scopes: isAmended ? [...pendingAmendScopes] : [],
    amend_reason: isAmended ? amendReason : null,
    stale_stages: isAmended ? [...pendingStaleStages] : [],
    drifted_files: driftedFiles,
    evidence_floor_seq: floors,
  };
}

export function activeSpecTaskIds(ledger: LedgerReader) {
  return ledger.db.query<{task_id:string},[]>("SELECT task_id FROM tasks WHERE status IN ('OPEN','HANDED_OFF')").all();
}

export function listActiveSpecLocks(ledger: LedgerReader, metadataOnly = false): TaskSpecState[] {
  const open = activeSpecTaskIds(ledger);
  const out: TaskSpecState[] = [];
  for (const t of open) {
    const st = getSpecState(ledger, t.task_id, { metadataOnly });
    if (st.state !== "NONE") out.push(st);
  }
  return out;
}
