import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { withReviewDelivery } from "./helpers/review-delivery";

const ref = (sha: string) => sha.slice(0, 7);
const issue = (role: string, seq: number) => new RegExp(`\\b${role}\\b[^\\n]*#${seq}\\b`);
const timeout = 30_000;

test("T01 an explicitly repaired blocked prefix delivers with the original native review session", () => {
  withReviewDelivery(f => {
    const h1 = f.change("first revision");
    const first = {summary: "Parser drops empty input", body: "# Finding\r\n\nEmpty input is lost.\n"};
    const seq = f.native(f.base, h1, {...first, status: "blocked"}).seq;
    f.native(f.base, h1, {role: "comments"});
    const d = f.change("preserve empty input");
    f.verify();
    expect(f.blocked(f.authorize())).toMatch(issue("quality", seq));
    const second = {summary: `Verified the parser repair #${seq}`, body: "# Passed\n\nRetested the empty input and the original repro.\n"};
    const resolution = f.native(h1, d, second).seq;

    const history = f.reviews();
    const rows = history.filter((row: {role: string}) => row.role === "quality");
    expect(rows).toMatchObject([
      {seq, status: "blocked", base: f.base, head: h1, summary: first.summary, session_id: "fixture-quality"},
      {seq: resolution, status: "pass", base: h1, head: d, summary: second.summary, session_id: "fixture-quality"},
    ]);
    expect(resolution).toBeGreaterThan(seq);
    for (const [index, row] of rows.entries())
      expect(readFileSync(resolve(f.s.work, row.report_path))).toEqual(Buffer.from([first.body, second.body][index]!));
    expect(history.filter((row: {role: string}) => row.role === "comments"))
      .toMatchObject([{base: f.base, head: h1, status: "pass"}]);
    const envelope = f.authorize();
    f.eligible(envelope);
    f.deliver(envelope);
    expect(f.reviews()).toEqual(history);
  });
}, timeout);

for (const [shape, ranges] of [
  ["three adjacent reports", [[0, 1], [1, 2], [2, 3]]],
  ["overlapping reports", [[0, 2], [1, 3]]],
  ["one full-range report", [[0, 3]]],
] as const) test(`T02 accepts ${shape}`, () => {
  withReviewDelivery(f => {
    const commits = [f.base];
    for (const step of [1, 2, 3]) {
      commits.push(f.change(`revision ${step}`));
      for (const [from, to] of ranges)
        if (to === step) f.native(commits[from]!, commits[to]!);
    }
    f.verify();
    f.eligible(f.authorize());
  });
}, timeout);

test("T02 accepts an overlapping range based on a merge's second parent", () => {
  withReviewDelivery(f => {
    f.git("switch", "-c", "other-parent", f.base);
    const second = f.change("side content", "side.txt");
    f.git("switch", "main");
    const first = f.change("main content");
    f.git("merge", "--no-ff", "-m", "join review paths", "other-parent");
    const merge = f.head();
    expect(f.git("show", "-s", "--format=%P", merge)).toBe(`${first} ${second}`);
    expect(f.git("rev-list", "--first-parent", merge).split("\n")).not.toContain(second);
    f.native(f.base, merge);
    const d = f.change("delivery content");
    expect(f.git("diff", "--name-only", second, d)).toContain("revision.txt");
    f.native(second, d);
    f.verify();
    f.eligible(f.authorize());
  });
}, timeout);

test("T03 a different role cannot supply a missing middle range", () => {
  withReviewDelivery(f => {
    const h1 = f.change("reviewed prefix");
    f.native(f.base, h1);
    const h2 = f.change("missing middle");
    const d = f.change("reviewed suffix");
    f.native(h2, d);
    f.verify();
    const diagnostic = f.blocked(f.authorize());
    expect(diagnostic).toContain("quality");
    expect(diagnostic).toContain(ref(h1));
    expect(diagnostic).toContain(ref(h2));
    f.native(h1, d, {role: "comments"});
    expect(f.blocked(f.authorize())).toContain("quality");
    f.native(h1, d);
    f.eligible(f.authorize());
  });
}, timeout);

test("T04 each failed review needs an explicit summary reference from its own role", () => {
  withReviewDelivery(f => {
    const d = f.change("review target");
    f.native(f.base, d, {role: "business"});
    const first = f.native(f.base, d, {status: "blocked", summary: "Parser finding"}).seq;
    const second = f.native(f.base, d, {status: "blocked", summary: "Writer finding"}).seq;
    const original = f.reviews();
    f.native(f.base, d, {role: "comments", summary: `Verified #${first} and #${second}`});
    f.native(f.base, d, {body: `# Passing\n\nChecked #${first} and #${second}.\n`});
    f.verify();
    const before = f.deliveryEvents();
    const blocked = f.blocked(f.authorize(), "run");
    const close = f.s.run([f.s.forge, "ledger", "close", f.task]);
    expect(close.code).toBe(1);
    for (const diagnostic of [blocked, close.out + close.err]) {
      expect(diagnostic).toMatch(issue("quality", first));
      expect(diagnostic).toMatch(issue("quality", second));
    }
    expect(f.status().task.status).toBe("OPEN");
    expect(f.remote()).toBe(f.base);
    expect(f.deliveryEvents()).toEqual(before);
    f.native(f.base, d, {summary: `Verified parser seq ${first}`, body: "The parser retains the empty value on replay.\n"});
    const remaining = f.blocked(f.authorize());
    expect(remaining).not.toMatch(new RegExp(`#${first}\\b`));
    expect(remaining).toMatch(issue("quality", second));
    f.native(f.base, d, {summary: `Verified writer #${second}`, body: "The writer round trip retains the full value.\n"});
    f.eligible(f.authorize());
    expect(f.reviews().slice(0, original.length)).toEqual(original);
  });
}, timeout);

for (const bridge of [false, true]) test(`T05 a later repair review ${bridge ? "joins a checked" : "leaves an uncovered"} interval`, () => {
  withReviewDelivery(f => {
    const h1 = f.change("found parser defect");
    const seq = f.native(f.base, h1, {status: "blocked"}).seq;
    const h2 = f.change("parser repair");
    if (bridge) f.native(h1, h2);
    const d = f.change("confirm parser behavior");
    f.native(h2, d, {
      summary: `Verified the repair #${seq}`,
      body: `# Verified\n\nInspected skipped range ${h1}..${h2}, replayed the original failing input at ${d}.\n`,
    });
    f.verify();
    const envelope = f.authorize();
    if (bridge) f.eligible(envelope);
    else {
      const diagnostic = f.blocked(envelope);
      expect(diagnostic).not.toMatch(new RegExp(`#${seq}\\b`));
      expect(diagnostic).toContain("quality");
      expect(diagnostic).toContain(ref(h1));
      expect(diagnostic).toContain(ref(h2));
    }
  });
}, timeout);

for (const failure of ["blocked", "incomplete"]) test(`T05 an insufficient range cannot clear ${failure}`, () => {
  withReviewDelivery(f => {
    const x = f.change("partial revision");
    const h1 = f.change("reported revision");
    const seq = f.native(f.base, h1, {status: failure}).seq;
    const d = f.change("repair candidate");
    f.native(f.base, d, {role: "business"});
    const summary = `Verified reported behavior #${seq}`;
    f.native(failure === "blocked" ? x : h1, d, {summary});
    f.verify();
    expect(f.blocked(f.authorize())).toMatch(issue("quality", seq));
    f.native(f.base, d, {summary, body: "The original published behavior and full covered range were checked against the repair.\n"});
    f.eligible(f.authorize());
    expect(f.reviews().find((row: {seq: number}) => row.seq === seq).status).toBe(failure);
  });
}, timeout);

test("T06 a report off the delivery ancestry cannot cover the new path", () => {
  withReviewDelivery(f => {
    const original = f.change("first path");
    f.native(f.base, original);
    // Probe the gate before the operator runs the amend/re-freeze recovery in T07.
    f.git("reset", "--hard", f.base);
    f.change("different path");
    f.verify();
    expect(f.blocked(f.authorize())).toMatch(/review/i);
  });
}, timeout);

test("T06 a common descendant cannot join unrelated review endpoints", () => {
  withReviewDelivery(f => {
    f.git("switch", "-c", "side", f.base);
    const side = f.change("side review start", "side.txt");
    f.git("switch", "main");
    const h1 = f.change("main review end");
    f.native(f.base, h1);
    f.git("merge", "--no-ff", "-m", "merge paths", "side");
    const d = f.head();
    f.native(side, d);
    f.verify();
    expect(f.blocked(f.authorize())).toMatch(/review/i);
    f.native(h1, d);
    f.eligible(f.authorize());
  });
}, timeout);

test("T06 reports the uncovered tail after a later full prefix supersedes an earlier internal range", () => {
  withReviewDelivery(f => {
    const h1 = f.change("first revision");
    const h2 = f.change("internal range end");
    f.native(h1, h2);
    const h3 = f.change("covered prefix end");
    f.native(f.base, h3);
    const d = f.change("unreviewed tail");
    f.verify();
    const diagnostic = f.blocked(f.authorize());
    expect(diagnostic).toContain("quality");
    expect(diagnostic).toContain(ref(h3));
    expect(diagnostic).toContain(ref(d));
    expect(diagnostic).not.toContain(ref(h2));
  });
}, timeout);

for (const scope of ["requirement", "test_spec"]) test(`T07 refreezing after ${scope} amendment invalidates earlier review coverage`, () => {
  withReviewDelivery(f => {
    const h1 = f.change("first review revision");
    f.native(f.base, h1);
    const oldFailure = f.native(f.base, h1, {role: "comments", status: "blocked"}).seq;
    const history = f.reviews();
    const original = f.ledger("spec-status", f.task);
    f.ledger("amend", f.task, "--scope", scope, "--reason", "Update fixture criteria");
    if (scope === "requirement") f.s.privateFile(f.scope, "Review the updated user-facing criteria.\n");
    f.freeze();
    const current = f.ledger("spec-status", f.task);
    expect(current.freeze_seq).toBeGreaterThan(original.freeze_seq);
    if (scope === "requirement") expect(current.evidence_floor_seq.review).toBeGreaterThan(original.evidence_floor_seq.review);
    else expect(current.evidence_floor_seq.review).toBe(original.evidence_floor_seq.review);
    const d = f.change("final revision");
    f.native(h1, d);
    f.verify();
    expect(f.blocked(f.authorize())).not.toMatch(new RegExp(`#${oldFailure}\\b`));
    f.native(f.base, d, {session: "fixture-new-cycle"});
    f.eligible(f.authorize());
    expect(f.reviews().slice(0, history.length)).toEqual(history);
  });
}, timeout);

test("T07 after rewriting reviewed commits, a refrozen task can be reviewed from its original baseline", () => {
  withReviewDelivery(f => {
    const original = f.change("original review revision");
    f.native(f.base, original, {status: "blocked"});
    const history = f.reviews();
    f.git("reset", "--hard", f.base);
    const d = f.change("rewritten revision");
    f.ledger("amend", f.task, "--scope", "requirement", "--reason", "Replace rewritten review history");
    f.freeze();
    f.native(f.base, d, {session: "fixture-rewritten"});
    f.verify();
    f.eligible(f.authorize());
    expect(f.reviews().slice(0, history.length)).toEqual(history);
  });
}, timeout);

test("T09 a revert cannot deliver the original tree even with individually reviewed segments", () => {
  withReviewDelivery(f => {
    const h1 = f.change("change to revert");
    f.native(f.base, h1);
    f.git("revert", "--no-edit", h1);
    const d = f.head();
    f.native(h1, d);
    expect(d).not.toBe(f.base);
    expect(f.git("rev-parse", d + "^{tree}")).toBe(f.git("rev-parse", f.base + "^{tree}"));
    f.verify();
    expect(f.blocked(f.authorize())).toMatch(/(?:tree|diff).*(?:same|no |empty|unchanged|equal)|(?:no |empty|unchanged|equal).*(?:tree|diff)/i);
  });
}, timeout);

test("T09 an interrupted Git object lookup fails closed and the same review can be reused", () => {
  withReviewDelivery(f => {
    const d = f.change("review target");
    f.native(f.base, d);
    f.verify();
    const envelope = f.authorize();
    f.eligible(envelope);
    const git = Bun.which("git", {PATH: f.s.env.PATH});
    if (!git) throw new Error("Missing fixture Git");
    const log = join(f.s.root, "git-interruption");
    const shim = join(f.s.bin, "git");
    writeFileSync(shim, [
      "#!/bin/sh",
      "for arg do",
      `  if [ "$arg" = '${d}^{tree}' ]; then`,
      `    printf '%s\\n' 66 > '${log}'`,
      "    exit 66",
      "  fi",
      "done",
      'exec "$FIXTURE_GIT" "$@"',
      "",
    ].join("\n"), {mode: 0o755});
    f.s.env.FIXTURE_GIT = git;
    try {
      expect(f.blocked(envelope)).toMatch(/(?:git|tree|review evidence).*(?:cannot|could not|unavailable|insufficient|failed)|(?:cannot|could not|unavailable|insufficient|failed).*(?:git|tree|review evidence)/i);
      expect(readFileSync(log, "utf8").trim()).toBe("66");
    } finally {
      writeFileSync(shim, '#!/bin/sh\nexec "$FIXTURE_GIT" "$@"\n');
    }
    f.eligible(f.authorize());
  });
}, timeout);
