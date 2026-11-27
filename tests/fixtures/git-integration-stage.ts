// The hosted fixture stores mutable PR state, branch protection, required checks and branches
// in one bare repository so a single update-ref transaction owns all merge preconditions.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [operation, host] = process.argv.slice(2);
const root = join(host, "remote.git"), statusFile = join(host,"host-pr.json");
const pr = JSON.parse(readFileSync(statusFile, "utf8"));
const [target] = JSON.parse(process.env.FORGE_APPROVED_TARGETS!);
const versions = JSON.parse(process.env.FORGE_APPROVED_HEADS!);
const {head, baseOid:base, tree:approvedTree} = target;
if (target.url !== pr.url || target.base !== "main" || target.number !== 1 || target.repo !== "app" ||
    versions.length !== 1 || versions[0].head !== head || versions[0].repo !== target.repo) process.exit(2);
const fact = {action_id: process.env.FORGE_ACTION_ID, endpoint:process.env.FORGE_ENDPOINT, versions};
const record = git(["cat-file","-p","refs/fixture/pr/1/state"]);
if (operation === "observe") {
  const accepted = record.startsWith("{") && JSON.parse(record);
  const complete = accepted && accepted.fact.action_id === fact.action_id && pr.state === "MERGED" &&
    pr.mergeCommit.oid === accepted.result && git(["rev-parse","refs/heads/main"]) === accepted.result &&
    git(["rev-parse",accepted.result+"^{tree}"]) === approvedTree;
  const optimistic = accepted && existsSync(join(host,"optimistic-observer"));
  console.log(JSON.stringify(complete || optimistic ? {...accepted.fact,state:"completed"} : {...fact,state:"absent"}));
  process.exit(0);
}
if (operation !== "submit" || pr.state !== "OPEN") process.exit(2);
appendFileSync(join(host,"submit-attempts"), JSON.stringify({target, fact}) + "\n");
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

const stateRef = "refs/fixture/pr/1/state",
  featureRef = "refs/heads/" + pr.headRefName,
  mainRef = "refs/heads/" + pr.baseRefName;
const raceInput = existsSync(race) ? JSON.parse(readFileSync(race, "utf8")) : null;
if (raceInput && raceInput.when !== "before-transaction") {
  const { when, other } = raceInput;
  if (when === "closed") {
    git(["update-ref", stateRef, digest("closed"), open]);
    writeFileSync(statusFile, JSON.stringify({ ...pr, state: "CLOSED" }));
  } else if (when === "head-change") {
    git(["update-ref", featureRef, other, head]);
    writeFileSync(statusFile, JSON.stringify({ ...pr, headRefOid: other }));
  } else if (when === "protection") git(["update-ref","refs/fixture/protection",digest("disabled")]);
  else if (when === "checks") git(["update-ref","refs/fixture/checks/"+head,digest("fail")]);
  else if (when === "rejected") process.exit(6);
  else git(["update-ref", mainRef, other, base]);
}
const tree = git(["merge-tree", "--write-tree", base, head]);
if (tree !== approvedTree) process.exit(5);
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
const merged = digest(JSON.stringify({fact,target,result}));
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
appendFileSync(join(host,"host-effects"), "merge " + result + "\n");
if (!existsSync(join(host,"hide-receipt")))
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
