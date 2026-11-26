// The hosted fixture stores mutable PR state, branch protection, required checks and branches
// in one bare repository so a single update-ref transaction owns all merge preconditions.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [route, ...args] = process.argv.slice(2);
const root = process.env.TARGET_GIT!,
  statusFile = process.env.PR_STATE!;
const pr = JSON.parse(readFileSync(statusFile, "utf8"));
const protocol = "forge.atomic-pr.v1",
  repository = "https://forge.example.test:8443/fixture/app";
const required = [
  "base_branch",
  "base_oid",
  "head_oid",
  "merge_tree",
  "open_pr",
  "protected_branch_rules",
  "required_checks",
];
if (route.endsWith("/capabilities")) {
  if (process.env.WITHHOLD_CAPABILITY) {
    console.log(JSON.stringify({atomic:true}));
    process.exit(0);
  }
  console.log(JSON.stringify({ protocol, repository, preconditions: required }));
  process.exit(0);
}
const fields = Object.fromEntries(args.filter((x) => x.includes("=")).map((x) => x.split("=")));
if (
  !route.endsWith("/pulls/1/merge") ||
  !args.includes("POST") ||
  fields.protocol !== protocol ||
  fields.pull_request !== pr.url ||
  fields.expected_state !== "OPEN" ||
  fields.expected_base_branch !== pr.baseRefName ||
  fields.policy !== "protected_branch_rules_and_required_checks" ||
  pr.state !== "OPEN" ||
  readFileSync(process.env.CI_STATE!, "utf8") !== "pass"
)
  process.exit(2);
function git(args: string[], stdin?: string) {
  const p = Bun.spawnSync(["git", "-C", root, ...args], {
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
  });
  if (p.exitCode !== 0) process.exit(3);
  return p.stdout.toString().trim();
}
const gate = join(root, "../receive-gate"),
  race = join(root, "../external-update");
if (existsSync(gate + ".armed")) {
  writeFileSync(gate + ".entered", "1");
  const deadline = Date.now() + 15_000;
  while (!existsSync(gate) && Date.now() < deadline) await Bun.sleep(20);
  if (!existsSync(gate)) process.exit(4);
}
const digest = (s: string) => git(["hash-object", "-w", "--stdin"], s);
const open = digest(JSON.stringify(["OPEN", pr.url, pr.baseRefName, pr.headRefName]));
const merged = digest(JSON.stringify(["MERGED", pr.url, pr.baseRefName, pr.headRefName]));
const stateRef = "refs/fixture/pr/1/state",
  featureRef = "refs/heads/" + pr.headRefName,
  mainRef = "refs/heads/" + pr.baseRefName;
const base = fields.expected_base_oid,
  head = fields.expected_head_oid;
const raceInput = existsSync(race) ? JSON.parse(readFileSync(race, "utf8")) : null;
if (raceInput && raceInput.when !== "before-transaction") {
  const { when, other } = raceInput;
  if (when === "closed") {
    git(["update-ref", stateRef, digest("closed"), open]);
    writeFileSync(statusFile, JSON.stringify({ ...pr, state: "CLOSED" }));
  } else if (when === "head-change") {
    git(["update-ref", featureRef, other, head]);
    writeFileSync(statusFile, JSON.stringify({ ...pr, headRefOid: other }));
  } else git(["update-ref", mainRef, other, base]);
}
const tree = git(["merge-tree", "--write-tree", base, head]);
if (tree !== fields.expected_merge_tree) process.exit(5);
const ff = Bun.spawnSync(["git", "-C", root, "merge-base", "--is-ancestor", base, head]).exitCode === 0;
const result = ff
  ? head
  : git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=test@example.invalid",
      "commit-tree",
      tree,
      "-p",
      base,
      "-p",
      head,
      "-m",
      "Hosted merge",
    ]);
if (raceInput?.when === "before-transaction") git(["update-ref", mainRef, raceInput.other, base]);
git(
  ["update-ref", "--stdin"],
  [
    "start",
    "verify " + featureRef + " " + head,
    "verify refs/fixture/protection " + digest("protected"),
    "verify refs/fixture/checks/" + head + " " + digest("pass"),
    "update " + stateRef + " " + merged + " " + open,
    "update " + mainRef + " " + result + " " + base,
    "prepare",
    "commit",
    "",
  ].join("\n"),
);
appendFileSync(process.env.TARGET_LOG!, "merge " + result + "\n");
if (!process.env.WITHHOLD_PR_RECEIPT)
  writeFileSync(
    statusFile,
    JSON.stringify({
      ...pr,
      state: "MERGED",
      mergedAt: new Date().toISOString(),
      mergeCommit: { oid: result },
    }),
  );
console.log(JSON.stringify({ merged: result }));
