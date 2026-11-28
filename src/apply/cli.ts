import { parseArgs } from "node:util";
import { findWorkbenchRoot } from "../config";
import { formatApplyScan, scanApply } from "./scan";

export const applyUsage = `forge apply [<dir>] [--repo <path>...] [--focus <rel-path>...] [--days N] [--json]
forge apply check [--repo <r>] [--domain <d> | --path <rel-path>...] [--json]
forge apply status [--repo <r>] [--json]`;

const jsonOption = { type: "boolean" } as const;

export async function runApplyCli(args: string[]) {
  const mode = args[0];
  if (args.includes("--help") || args.includes("-h")) {
    console.log(applyUsage);
    return;
  }

  if (mode === "check" || mode === "status") {
    const { values } = parseArgs({
      args: args.slice(1), options: {
        repo: { type: "string", multiple: true }, json: jsonOption,
        domain: { type: "string", multiple: true }, path: { type: "string", multiple: true },
      },
    });
    if ((values.repo?.length ?? 0) > 1) throw Error("--repo may only be supplied once for " + mode);
    if (mode === "status" && (values.domain || values.path)) throw Error("--domain and --path apply only to check.");
    if ((values.domain?.length ?? 0) > 1) throw Error("--domain may only be supplied once.");
    if (values.domain && values.path) throw Error("Use either --domain or --path.");
    const { runApplyProbe, formatApplyProbe } = await import("./probe");
    const output = runApplyProbe(findWorkbenchRoot(), mode, { repo: values.repo?.[0], domain: values.domain?.[0], paths: values.path ?? [] });
    console.log(values.json ? JSON.stringify(output, null, 2) : formatApplyProbe(output));
    if (output.errors.length) process.exitCode = 1;
    return;
  }

  const { values, positionals } = parseArgs({
    args, allowPositionals: true, options: {
      repo: { type: "string", multiple: true }, focus: { type: "string", multiple: true },
      days: { type: "string", multiple: true }, json: jsonOption,
    },
  });
  if (positionals.length > 1) throw Error(applyUsage);
  const daysArg = values.days?.[0] ?? "90";
  const days = Number(daysArg);
  if ((values.days?.length ?? 0) > 1 || !/^\d+$/.test(daysArg) || !Number.isSafeInteger(days) || days <= 0)
    throw Error("--days must be a positive integer.");
  const target = positionals[0];
  const output = scanApply(findWorkbenchRoot(target, target !== undefined), { repos: values.repo ?? [], focus: values.focus ?? [], days });
  console.log(values.json ? JSON.stringify(output, null, 2) : formatApplyScan(output));
}
