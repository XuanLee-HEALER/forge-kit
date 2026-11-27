import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { developerGit } from "../tests/helpers/git-tool";

const root = resolve(import.meta.dir, "..");
const started = performance.now();
const workers = Math.min(8, availableParallelism());
const delivery = "tests/v05-delivery.test.ts";
const selected = process.argv.slice(2).map(path => relative(root, resolve(path)));
const jobs: {file: string; shard: number; shards: number}[] = [];
const files = new Bun.Glob("tests/**/*{.test,.spec,_test,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}").scanSync(root);
for (const file of [...files].sort()) {
  if (selected.length && !selected.includes(file)) continue;
  const shards = file === delivery ? workers : 1;
  for (let shard = 0; shard < shards; shard++) jobs.push({file, shard, shards});
}
if (!jobs.length || selected.some(path => !jobs.some(job => job.file === path))) throw Error("Unknown test file");
// Start the baseline's longest files alongside the delivery shards so none
// becomes a serial tail after the other workers have finished.
const longest = ["fast-track", "ship-plan-regressions", "release-train"].map(name => "tests/" + name + ".test.ts");
function priority(job: typeof jobs[number]) {
  return longest.includes(job.file) ? 2 : job.file === delivery ? 1 : 0;
}
jobs.sort((a, b) => priority(b) - priority(a));
const temporary = mkdtempSync(join(tmpdir(), "forge-test-suite-"));
const bundle = join(temporary, "cli.js");
const totals = {pass: 0, fail: 0, skip: 0};
const fileTimes = new Map<string, {start:number; end:number}>();
let failed = false;
try {
  let path = process.env.PATH;
  if (developerGit && Bun.which("git") === "/usr/bin/git") {
    symlinkSync(developerGit, join(temporary, "git"));
    path = temporary + ":" + path;
  }
  if (jobs.some(job => job.file === delivery)) {
    const build = Bun.spawnSync([process.execPath, "build", "--target=bun", "--outfile", bundle, "src/bin/cli.ts"], {cwd:root});
    if (build.exitCode !== 0) throw Error(build.stderr.toString());
    chmodSync(bundle, 0o444);
  }
  async function worker() {
    for (let job; (job = jobs.shift());) {
      const {file, shard, shards} = job;
      const start = performance.now();
      if (!fileTimes.has(file)) fileTimes.set(file, {start, end:start});
      const child = Bun.spawn([process.execPath, "test", "./" + file], {
        cwd: root, stdout: "pipe", stderr: "pipe", env: {...process.env, PATH: path, FORCE_COLOR: "0",
          FORGE_DELIVERY_SHARD: String(shard), FORGE_DELIVERY_SHARDS: String(shards), FORGE_TEST_CLI_BUNDLE: bundle},
      });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const output = out + err;
      fileTimes.get(file)!.end = performance.now();
      process.stdout.write(output);
      for (const key of ["pass", "fail", "skip"] as const) {
        const count = new RegExp("^\\s*(\\d+) " + key + "$", "m").exec(output);
        totals[key] += Number(count?.[1] ?? 0);
      }
      if (code !== 0) failed = true;
      const group = shards > 1 ? " shard " + (shard + 1) + "/" + shards : "";
      console.log("File " + file + group + " " + Math.round(performance.now() - start) + "ms (exit " + code + ")");
    }
  }
  const completed = await Promise.allSettled(Array.from({length: workers}, worker));
  for (const result of completed) if (result.status === "rejected") throw result.reason;
  if (fileTimes.has(delivery)) {
    const {start, end} = fileTimes.get(delivery)!;
    console.log("File " + delivery + " (all shards) " + Math.round(end - start) + "ms");
  }
  console.log("test:all " + JSON.stringify({...totals, wall_ms: Math.round(performance.now() - started), workers}));
  if (failed) process.exitCode = 1;
} finally {
  rmSync(temporary, {recursive:true, force:true});
}
