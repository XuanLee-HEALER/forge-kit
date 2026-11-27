import { createHash } from "node:crypto";
import { readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Repo } from "./repo";
import { cleanReport, ReportTextError, type Finding } from "./report";
import { roles, instructions, type Role } from "./roles";
import { BackendFailure, invoke } from "./backend";
import { modelPair, type Model } from "./models";
import { prepareMaterials, batchChanges, batches, loadChunk, type Chunk, type Material } from "./materials";

export type Status = "pass" | "blocked" | "incomplete" | "error";
export const reviewExitCode = (status: Status) => ({ pass: 0, blocked: 1, incomplete: 3, error: 2 })[status];
const modes = ["parallel", "serial", "ordered"] as const;
type Mode = typeof modes[number];
type Option = { roles?: string; mode?: string; order?: string };
type Attempt = { backend: "codex"; status: Status; reason?: string };
type RoleReport = {
  role: Role; base: string; head: string; status: Status; backend: "codex" | null;
  coverage: { expected: number; reviewed: number; missing: Array<{id:string; path:string}> };
  missing_materials?: string[]; findings: Finding[]; limitations: string[]; summary: string; attempts: Attempt[];
};

export const reviewOptions = {
  repo: { type: "string" }, base: { type: "string" }, head: { type: "string" },
  roles: { type: "string" }, order: { type: "string" }, mode: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
} as const;

function selection(csv: string, available: readonly Role[]) {
  const list = csv.split(",") as Role[];
  if (!list.every(role => available.includes(role)) || new Set(list).size !== list.length)
    throw Error("Expected nonempty unique roles from " + available.join(","));
  return list;
}

export function reviewSelection(opts: Option, available: readonly Role[]) {
  const requested = selection(opts.roles ?? available.join(","), available);
  const mode = (opts.mode ?? "parallel") as Mode;
  if (!modes.includes(mode)) throw Error("Invalid mode");
  let sequence = available.filter(r => requested.includes(r));
  if (mode === "ordered") {
    if (!opts.order) throw Error("ordered mode requires --order");
    const order = selection(opts.order, available);
    if (order.length !== sequence.length || !order.every(r => sequence.includes(r))) throw Error("--order must cover the selected roles");
    sequence = order;
  } else if (opts.order !== undefined) throw Error("--order requires ordered mode");
  return { mode, sequence };
}

const PROMPT_BYTES = 160_000;
const RESPONSE_RESERVE = 20_000;
type Specification = { text?: string; limitation?: string };
function specification(params: {spec?:string; specSha256?:string}): Specification {
  if (!params.spec) return {};
  try {
    if (statSync(params.spec).size > PROMPT_BYTES - RESPONSE_RESERVE)
      return {limitation:"Specification alone exceeds the prompt budget"};
    const bytes = readFileSync(params.spec);
    if (!params.specSha256 || createHash("sha256").update(bytes).digest("hex") === params.specSha256) {
      const text = bytes.toString("utf8");
      return {text: text.trim() ? text : undefined};
    }
  } catch { /* Missing or changed specifications become explicit gaps. */ }
  return {};
}

async function reviewRole(role: Role, repo: Repo, material: Material, model: Model, specification: Specification, requiredSpec = false): Promise<RoleReport> {
  const { base, head } = repo;
  const spec = specification.text;
  const checked = new Set<string>();
  const findings = new Map<string, Finding>();
  const limitations = new Set(material.limitations);
  const gaps = new Set(material.missing);
  const attempts: Attempt[] = [];
  const summaries = new Set<string>();
  if (requiredSpec && !spec) gaps.add("spec");
  if (specification.limitation) limitations.add(specification.limitation);
  const envelope = {role, base, head, spec: spec ?? null, index: material.index,
    instructions: instructions(role, repo.files) + "\nReview every supplied chunk, including deletions and metadata. Return the supplied role. For every chunk return its exact id, path and conclusion in checked. Use reviewed only after inspecting its actual patch. Files in the global index outside this batch are reviewed separately. For findings use the new-file range, or the old-file range for deleted lines."};

  async function batch(chunks: Chunk[]): Promise<void> {
    const items = chunks.map(c => loadChunk(material, c));
    const related = batchChanges(material.byPath, chunks);
    const diff: Record<string, string> = Object.create(null);
    for (const item of items) diff[item.path] = (diff[item.path] ?? "") + item.patch;
    let context: Awaited<ReturnType<Repo["context"]>>;
    let contextFailed = false;
    try { context = await repo.context(diff); }
    catch {
      const paths = Object.keys(diff);
      context = {revision:head, files:[], omitted:paths};
      contextFailed = true;
    }
    const render = () => JSON.stringify({...envelope, related, context, chunks:items});
    let prompt = render();
    while (Buffer.byteLength(prompt) + RESPONSE_RESERVE > PROMPT_BYTES && context.files.length) {
      context.omitted.push(context.files.pop()!.path);
      prompt = render();
    }
    if (Buffer.byteLength(prompt) + RESPONSE_RESERVE > PROMPT_BYTES) {
      if (chunks.length === 1) { limitations.add("Prompt budget exceeded for " + chunks[0].id); return; }
      const half = Math.ceil(chunks.length / 2);
      await batch(chunks.slice(0, half));
      await batch(chunks.slice(half));
      return;
    }
    if (contextFailed) {
      const paths = Object.keys(diff);
      for (const path of paths) gaps.add(path);
      limitations.add("Unable to load pinned caller and dependency context for " + paths.join(", "));
    }
    try {
      const paths = related.map(c => c.path);
      const report = cleanReport(await invoke(prompt, model), paths);
      if (report.role !== role) throw new BackendFailure("Codex receipt role mismatch");
      const receipts = new Set<string>();
      const completed = new Set<string>();
      for (const ack of report.checked) {
        if (receipts.has(ack.id) || !chunks.some(c => c.id === ack.id && c.path === ack.path))
          throw new BackendFailure("Codex receipt contains duplicate or undelivered material");
        receipts.add(ack.id);
        if (ack.conclusion === "reviewed") completed.add(ack.id);
      }
      for (const f of report.findings) {
        const located = chunks.some(c => c.path === f.path &&
          ((c.newStart > 0 && f.line >= c.newStart && f.line <= c.newEnd) ||
          c.deletedRanges.some(([first,last]) => f.line >= first && f.line <= last)));
        if (!located) throw new BackendFailure("Finding location outside delivered patch");
      }
      for (const f of report.findings) {
        const key = JSON.stringify([f.path,f.line,f.title]);
        if (f.severity === "blocking" || !findings.has(key)) findings.set(key, f);
      }
      for (const l of report.limitations) limitations.add(l);
      summaries.add(report.summary);
      for (const id of completed) checked.add(id);
      if (report.status === "incomplete") limitations.add("Batch reported incomplete: " + report.summary);
      const status = contextFailed || report.status === "incomplete" || completed.size < chunks.length ? "incomplete" :
        report.findings.some(f => f.severity === "blocking") ? "blocked" : "pass";
      attempts.push({backend:"codex", status});
    } catch (error) {
      const reason = error instanceof BackendFailure || error instanceof ReportTextError ? error.message : "Invalid Codex structured response";
      limitations.add(reason);
      attempts.push({backend:"codex", status:"incomplete", reason});
      // A failed process can leave the rest of a run undelivered. The final
      // difference is computed against the original inventory, including it.
      throw new BackendFailure(reason);
    }
  }

  if (!requiredSpec || spec) {
    try {
      for (const group of batches(material.chunks)) await batch(group);
    } catch (error) {
      if (!(error instanceof BackendFailure)) throw error;
    }
  }
  const missing = material.chunks.filter(c => !checked.has(c.id)).map(({path,id}) => ({path,id}));
  for (const c of missing) gaps.add(c.path);
  const list = [...findings.values()];
  const status = gaps.size || attempts.some(a => a.status === "incomplete") ? "incomplete" : list.some(f => f.severity === "blocking") ? "blocked" : "pass";
  const summary = status === "incomplete" ? "Incomplete review: " + [...limitations, ...gaps].join(", ") : [...summaries].join("\n");
  return {role, base, head, backend:attempts.length ? "codex" : null, attempts, status, summary, findings:list,
    limitations:[...limitations], ...(gaps.size && {missing_materials:[...gaps]}),
    coverage:{expected:material.chunks.length, reviewed:checked.size, missing}};
}

export async function runReview(params: Option & {
  repo: string; base: string; head: string; spec?: string; specSha256?: string;
  models?: Partial<Record<Role, {model:string;effort:string}>>; model?: {model:string;effort:string};
  legacyPerformanceRetry?: boolean;
}) {
  const { mode, sequence } = reviewSelection(params, params.legacyPerformanceRetry ? ["performance"] : roles);
  const models = sequence.map(role => {
    const pair = params.models?.[role] ?? params.model;
    return modelPair(pair?.model, pair?.effort);
  });
  const repo = new Repo(params.repo, params.base, params.head);
  repo.git(["merge-base", "--is-ancestor", repo.base, repo.head]);
  if (!repo.files.length && !repo.excludedFiles.length) throw Error("Empty review diff; select a range containing changes");
  const spec = specification(params);
  const tmp = mkdtempSync(join(tmpdir(), "forge-review-material-"));
  try {
    const material = prepareMaterials(repo, tmp);
    const run = (role: Role, idx:number) => reviewRole(role, repo, material, models[idx], spec, role === "business" || !!params.spec);
    const reports: RoleReport[] = [];
    if (mode === "parallel") reports.push(...await Promise.all(sequence.map(run)));
    else for (const [idx,role] of sequence.entries()) reports.push(await run(role,idx));
    const status = (["incomplete", "blocked", "pass"] as const).find(s => reports.some(r => r.status === s))!;
    return {schemaVersion:2, base:repo.base, head:repo.head, mode, status, roles:reports};
  } finally { rmSync(tmp, {recursive:true, force:true}); }
}

export async function standalone(args: string[]) {
  const { values } = parseArgs({ args, options: {...reviewOptions, spec: { type:"string" } } });
  if (!values.repo || !values.base || !values.head) throw Error("Expected --repo, --base and --head");
  return runReview({...values, repo:values.repo, base:values.base, head:values.head, model:modelPair(values.model, values.effort)});
}
