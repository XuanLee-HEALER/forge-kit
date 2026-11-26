import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Repo } from "./repo";
import { validateReport } from "./report";
import { roles, instructions, type Role } from "./roles";
import { BackendFailure, invoke, type Backend, type Model } from "./backend";

export type Status = "pass" | "blocked" | "incomplete" | "error";
export const reviewExitCode = (status: Status) => ({ pass: 0, blocked: 1, incomplete: 3, error: 2 })[status];
const modes = ["parallel", "serial", "ordered"] as const;
type Mode = typeof modes[number];
type Option = { roles?: string; mode?: string; order?: string; backend?: string };
type Finding = ReturnType<typeof validateReport>["findings"][number];
type Attempt = { backend: Backend; status: Status; reason?: string };
type RoleReport = {
  role: Role; base: string; head: string; status: Status; backend: Backend | null;
  missing_materials?: string[]; findings: Finding[]; summary: string; attempts: Attempt[];
};

export const reviewOptions = {
  repo: { type: "string" }, base: { type: "string" }, head: { type: "string" },
  roles: { type: "string" }, order: { type: "string" }, mode: { type: "string" }, backend: { type: "string" },
} as const;

function selection(csv: string) {
  const list = csv.split(",") as Role[];
  if (!list.every(role => roles.includes(role)) || new Set(list).size !== list.length)
    throw Error("Expected nonempty unique roles from " + roles.join(","));
  return list;
}

function options(opts: Option) {
  const requested = selection(opts.roles ?? roles.join(","));
  const mode = (opts.mode ?? "parallel") as Mode;
  if (!modes.includes(mode)) throw Error("Invalid mode");
  let sequence = roles.filter(r => requested.includes(r));
  if (mode === "ordered") {
    if (!opts.order) throw Error("ordered mode requires --order");
    const order = selection(opts.order);
    if (order.length !== sequence.length || !order.every(r => sequence.includes(r))) throw Error("--order must cover the selected roles");
    sequence = order;
  } else if (opts.order !== undefined) throw Error("--order requires ordered mode");
  const backend = opts.backend ?? "auto";
  if (backend !== "auto" && backend !== "codex" && backend !== "api") throw Error("Invalid backend");
  return { mode, sequence, backend } as const;
}

function materials(repo: Repo) {
  const diff: Record<string, string> = Object.create(null);
  const missing = [...repo.excludedFiles];
  let bytes = 0;
  for (const file of repo.files) {
    try {
      let next = 0;
      const chunks = [];
      do {
        const page = repo.diff(file, next);
        bytes += Buffer.byteLength(page.text);
        if (bytes > 1_500_000) throw Error("material limit");
        chunks.push(page.text);
        next = page.truncated ? page.nextOffset : 0;
      } while (next);
      diff[file] = chunks.join("\n");
    } catch { missing.push(file); }
  }
  return { diff, missing: [...new Set([...missing, ...repo.missing()])] };
}

export async function runReview(params: Option & {
  repo: string; base: string; head: string; spec?: string; specSha256?: string;
  models?: Partial<Record<Role, Model>>; model?: Model;
}) {
  const { mode, sequence, backend } = options(params);
  const repo = new Repo(params.repo, params.base, params.head);
  const { base, head } = repo;
  repo.git(["merge-base", "--is-ancestor", base, head]);
  if (!repo.files.length && !repo.excludedFiles.length) throw Error("Empty review diff; select a range containing changes");
  const material = materials(repo);
  let context: ReturnType<Repo["context"]> | undefined;
  if (!material.missing.length) {
    try { context = repo.context(material.diff); }
    catch { material.missing.push("pinned source context"); }
  }
  let spec: string | undefined;
  if (params.spec) {
    try {
      const bytes = readFileSync(params.spec);
      if (!params.specSha256 || createHash("sha256").update(bytes).digest("hex") === params.specSha256)
        spec = bytes.toString("utf8").trim() || undefined;
    } catch { /* The business role reports missing material. */ }
  }
  async function run(role: Role): Promise<RoleReport> {
    const common = { role, base, head };
    const missing = [...material.missing];
    if (role === "business" && !spec) missing.push("spec");
    if (missing.length) return { ...common, backend: null, missing_materials: missing, findings: [], attempts: [], summary: "Missing review material: " + missing.join(", "), status: "incomplete" };
    const prompt = JSON.stringify({ role, base, head, instructions: instructions(role, repo.files), spec: spec ?? null, diff: material.diff, context });
    const model = params.models?.[role] ?? params.model ?? { model: process.env.REVIEW_MODEL || "gpt-6.2-sol", effort: "medium" };
    const attempts: Attempt[] = [];
    const backends: Backend[] = backend === "auto" ? ["codex", "api"] : [backend];
    for (const active of backends) {
      try {
        const report = validateReport(await invoke(active, prompt, model), repo.files, []);
        const status = report.status === "findings" ? "blocked" : report.status;
        attempts.push({ backend: active, status });
        return { ...common, backend: active, attempts, findings: report.findings, summary: report.summary, status };
      } catch (error) {
        const summary = error instanceof BackendFailure ? error.message : "Unable to execute backend or validate report";
        attempts.push({ backend: active, status: "error", reason: summary });
        if (backend === "auto" && active === "codex" && error instanceof BackendFailure && error.upstream) continue;
        return { ...common, backend: active, attempts, findings: [], summary, status: "error" };
      }
    }
    throw Error("No review backend selected");
  }
  const reports: RoleReport[] = [];
  if (mode === "parallel") reports.push(...await Promise.all(sequence.map(run)));
  else for (const role of sequence) reports.push(await run(role));
  const status = (["error", "incomplete", "blocked", "pass"] as const).find(s => reports.some(r => r.status === s))!;
  return { schemaVersion: 1, base, head, mode, status, roles: reports };
}

export async function standalone(args: string[]) {
  const { values } = parseArgs({ args, options: {
    ...reviewOptions, spec: { type: "string" }, model: { type: "string" }, effort: { type: "string" },
  } });
  if (!values.repo || !values.base || !values.head) throw Error("Expected --repo, --base and --head");
  return runReview({ ...values, repo: values.repo, base: values.base, head: values.head,
    model: { model: values.model || process.env.REVIEW_MODEL || "gpt-6.2-sol", effort: values.effort || "medium" },
  });
}
