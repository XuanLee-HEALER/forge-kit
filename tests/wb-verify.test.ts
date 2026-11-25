import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { executorFixture } from "./helpers/executor";
const f = executorFixture();
const verify = (kind: string, ...cmd: string[]) => f.cli("wb-verify", ["--kind", kind, "--", ...cmd]);
test("pinned tool passes count for readiness and a failing command supersedes a pass", () => {
  writeFileSync(join(f.repo, "app.ts"), "export const answer = 42;");
  writeFileSync(
    join(f.repo, "app.test.ts"),
    'import {test, expect} from "bun:test";test("answer",()=>expect(process.env.TEST_FAILURE).toBeUndefined());',
  );
  f.git("add", ".");
  f.git("commit", "-m", "verification suite");
  const ready = () =>
    f.ledger.checkPushReadiness({ task_id: "task", repo: "service", head_sha: f.git("rev-parse", "HEAD") })
      .ready;
  expect(verify("test", "bun", "test").exitCode).toBe(0);
  expect(verify("build", "bun", "build", "app.ts").exitCode).toBe(0);
  expect(f.evidence()[0]).toMatchObject({
    source: "tool",
    kind: "test",
    meta: { review_task_id: "task", review_floor_seq: 0, exit_code: 0 },
  });
  expect(ready()).toBe(true);
  expect(f.cli("wb-verify", ["--kind", "test", "--", "bun", "test"], { TEST_FAILURE: "yes" }).exitCode).toBe(1);
  expect(f.evidence().at(-1)).toMatchObject({ status: "fail", meta: { exit_code: 1 } });
  expect(ready()).toBe(false);
});
test("rejects dirty trees, changed HEAD, post-check edits, skipped phases and informational Hurl", () => {
  expect(f.cli("wb-verify", ["--mode", "all"]).exitCode).toBe(1);
  expect(verify("hurl", "hurl", "--version").exitCode).toBe(1);
  for(const args of [["-b","-d"],["--all"],["-BUILD","--d"],["--B","-DRY"],["-?"],["-listFilesOnly"]])
    expect(verify("build","tsc",...args).exitCode).toBe(1);
  for (const args of [
    ["echo", "checked"],
    ["bun", "-e", "0"],
    ["pytest", "--collect-only"],
    ["pytest","--collectonly"],
    ["pytest","--co"],
    ["pytest","-VV"],
    ["go", "test", "-n"],
    ["go","test","-test.list","."],
    ["go","test","-args","-test.list=."],
    ["go","test","-args","-help"],
  ])
    expect(verify("test", ...args).exitCode).toBe(1);
  writeFileSync(
    join(f.repo, "edit.test.ts"),
    'import {test} from "bun:test"; test("edit",async()=>{await Bun.write("edit","changed")});',
  );
  f.git("add", ".");
  f.git("commit", "-m", "mutation fixture");
  expect(verify("test", "bun", "test").exitCode).toBe(1);
  expect(verify("test", "bun", "test").exitCode).toBe(1);
  f.git("clean", "-f");
  writeFileSync(
    join(f.repo, "edit.test.ts"),
    'import {test} from "bun:test"; test("commit",()=>{Bun.spawnSync(["git","commit","--allow-empty","-m","changed"])});',
  );
  f.git("commit", "-am", "HEAD movement fixture");
  expect(verify("test", "bun", "test").exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
});
test("verification rejects committed frozen-test drift", () => {
  const docs = join(f.root, ".workbench/specs/task");
  mkdirSync(docs, { recursive: true });
  for (const file of ["ssot", "tech-spec", "test-spec"]) writeFileSync(join(docs, file + ".md"), file);
  f.ledger.freezeSpec({ task_id: "task", locked_test_globs: ["code.txt"] });
  writeFileSync(join(f.repo, "code.txt"), "changed");
  f.git("commit", "-am", "changed contract");
  expect(verify("test", "bun", "test").exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
});

test("default language checks credit each executed phase at the attached worktree", () => {
  const linked = join(f.root, "feature-linked");
  f.git("switch", "-c", "other");
  f.git("worktree", "add", linked, "feature");
  writeFileSync(join(linked, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  writeFileSync(join(linked, "tsconfig.json"), JSON.stringify({ files: ["app.ts"] }));
  writeFileSync(join(linked, "app.ts"), "export const value = 1;");
  writeFileSync(join(linked, "bunfig.toml"), "");
  writeFileSync(
    join(linked, "app.test.ts"),
    'import {test,expect} from "bun:test"; test("value", () => expect(1).toBe(1));',
  );
  const tsc = join(linked, "node_modules/.bin/tsc");
  mkdirSync(join(linked, "node_modules/.bin"), { recursive: true });
  writeFileSync(tsc, '#!/bin/sh\nprintf "\\377"\n', { mode: 0o755 });
  writeFileSync(join(linked, ".gitignore"), "node_modules/\n");
  f.git("-C", linked, "add", ".");
  f.git("-C", linked, "commit", "-m", "checks");
  const r = f.cli("wb-verify", ["--task", "task", "--repo", "service", "--mode", "all"]);
  expect(r.exitCode, r.stdout.toString()).toBe(0);
  expect(f.evidence().map((e) => e.kind)).toEqual(["lint", "test"]);
  expect(f.evidence()[0].meta.output_sha256).toBe(
    new Bun.CryptoHasher("sha256").update(Uint8Array.of(255)).digest("hex"),
  );
});

test("explicit command digests use the original stdout and stderr bytes", () => {
  writeFileSync(join(f.repo, "Makefile"), "check:\n\t@printf '\\377'; printf '\\376' >&2\n");
  f.git("add", ".");
  f.git("commit", "-m", "check output");
  expect(verify("build", "make", "-C", f.root, "check").exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  expect(verify("build", "make", "-C", ".", "check").exitCode).toBe(0);
  expect(f.evidence()[0]).toMatchObject({kind: "build", status: "pass"});
  const result = verify("build", "make", "check");
  expect(result.exitCode).toBe(0);
  expect(f.evidence().at(-1).meta.output_sha256).toBe(
    new Bun.CryptoHasher("sha256").update(Uint8Array.of(255, 254)).digest("hex"),
  );
});

test("Hurl requires every positional file to belong to the pinned revision", () => {
  writeFileSync(join(f.repo, "good.hurl"), "GET http://localhost");
  writeFileSync(join(f.root, "other.hurl"), "outside checkout");
  mkdirSync(join(f.repo, "contracts"));
  writeFileSync(join(f.repo, "contracts", "nested.hurl"), "GET http://localhost");
  symlinkSync("contracts", join(f.repo, "contract-link"));
  symlinkSync(join(f.root, "other.hurl"), join(f.repo, "link.hurl"));
  f.git("add", ".");
  f.git("commit", "-m", "contracts");
  const hurl = join(f.root, "hurl");
  writeFileSync(hurl, "#!/bin/sh\nexit 0", { mode: 0o755 });
  for (const args of [
    ["good.hurl", join(f.root, "other.hurl")],
    ["link.hurl"],
    ["--variables-file", "good.hurl"],
  ])
    expect(verify("hurl", hurl, ...args).exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  expect(verify("hurl", hurl, "contract-link/nested.hurl").exitCode).toBe(0);
  expect(verify("hurl", hurl, "--output", "result", "-m", "5", "--max-filesize", "4096", "--repeat", "2", "--test", "good.hurl").exitCode).toBe(0);
});
test("empty Bun suite earns no explicit or dynamic verification credit", () => {
  writeFileSync(join(f.repo, "empty.test.ts"), "export {};");
  writeFileSync(join(f.repo, "bunfig.toml"), "");
  writeFileSync(join(f.repo, "package.json"), "{}");
  f.git("add", ".");
  f.git("commit", "-m", "empty suite");
  expect(verify("test", "bun", "test").exitCode).toBe(1);
  expect(f.cli("wb-verify", ["--mode", "dynamic"]).exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
});

test("Go package and pytest collection results distinguish skipped tests from execution", () => {
  const bin = join(f.root, "tools");
  mkdirSync(bin);
  const env = { PATH: bin + ":" + process.env.PATH };
  const go = join(bin, "go");
  writeFileSync(go, "#!/bin/sh\nprintf '?  example/a [no test files]\\n'\n", { mode: 0o755 });
  writeFileSync(join(f.repo, "go.mod"), "module example");
  f.git("add", ".");
  f.git("commit", "-m", "module");
  const dynamic = () => f.cli("wb-verify", ["--mode", "dynamic"], env);
  expect(dynamic().exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  writeFileSync(go, "#!/bin/sh\nprintf '?  example/a [no test files]\\nok  example/b 0.01s\\n'\n");
  expect(f.cli("wb-verify", ["--mode", "dynamic"], {...env, GOFLAGS: "-n"}).exitCode).toBe(1);
  expect(f.evidence().map(e => e.status)).toEqual(["fail"]);
  const settings = join(f.root, "go-env");
  writeFileSync(settings, "GOFLAGS='-n'\n");
  writeFileSync(go, "#!/bin/sh\nif [ \"$1\" = env ]; then sed -n 's/^GOFLAGS=//p' \"$GOENV\"; else echo 'ok  example/b 0.01s'; fi\n");
  const saved = {...env, GOENV: settings, GOFLAGS: ""};
  expect(f.cli("wb-verify", ["--kind", "test", "--", go, "test", "./..."], saved).exitCode).toBe(1);
  expect(f.cli("wb-verify", ["--mode", "dynamic"], saved).exitCode).toBe(1);
  expect(f.evidence().map(e => e.status)).toEqual(["fail", "fail"]);
  writeFileSync(go, "#!/bin/sh\nif [ \"$1\" != env ]; then echo 'ok  example/b 0.01s'; fi\n");
  expect(dynamic().exitCode).toBe(0);
  expect(f.cli("wb-verify", ["--kind", "test", "--", go, "test", "-n=false", "./..."], env).exitCode).toBe(0);
  writeFileSync(join(bin, "pytest"), "#!/bin/sh\nexit 5\n", { mode: 0o755 });
  expect(f.cli("wb-verify", ["--kind", "test", "--", "pytest"], env).exitCode).toBe(1);
  expect(f.evidence().map(e => e.status)).toEqual(["fail", "fail", "pass", "pass"]);
});

test("empty Bun output through a package script earns no credit", () => {
  writeFileSync(join(f.repo, "empty.test.ts"), "export {};");
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  f.git("add", ".");
  f.git("commit", "-m", "empty delegated suite");
  expect(verify("test", "npm", "run", "test").exitCode).toBe(1);
  expect(f.cli("wb-verify", ["--mode", "dynamic"]).exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
});

test("named package scripts execute and a passing suite may mention 0 tests", () => {
  writeFileSync(join(f.repo,"suite.test.ts"),'import {test} from "bun:test"; test("0 tests failed out of 12",()=>{});');
  writeFileSync(join(f.repo,"app.ts"),"export const docs = 1;");
  writeFileSync(join(f.repo,"package.json"), JSON.stringify({scripts:{test:"bun test",testIntegration:"bun test",buildDocs:"bun build app.ts"}}));
  f.git("add","."); f.git("commit","-m","named scripts");
  expect(verify("test","npm","run","testIntegration","-v").exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  expect(verify("test","npm","--no-usage=false","run","test").exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  expect(verify("test", "npm", "--prefix", f.root, "run", "test").exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  expect(verify("test", "npm", "--prefix", ".", "run", "test").exitCode).toBe(0);
  expect(verify("test","npm","--dry-run=false","run","test").exitCode).toBe(0);
  expect(verify("test","npm","--dry-run","false","run","test").exitCode).toBe(0);
  expect(verify("test","npm","--dry-run","--no-dry-run","run","test").exitCode).toBe(0);
  expect(verify("test","npm","--no-color","run","testIntegration","--loglevel=verbose").exitCode).toBe(0);
  expect(verify("test","npm","--ignore-scripts","run","test").exitCode).toBe(0);
  expect(verify("build","npm","run","buildDocs").exitCode).toBe(0);
  expect(f.cli("wb-verify",["--mode","dynamic"]).exitCode).toBe(0);
  expect(f.evidence().map(e=>e.kind)).toEqual(["test","test","test","test","test","test","build","test"]);
});

test("Go JSON package results count passing and skipped packages", () => {
  const go=join(f.root,"go"), cmd=()=>verify("test",go,"test","-json","./...");
  const skipped=JSON.stringify({Action:"skip",Package:"example/a"});
  const passed=JSON.stringify({Action:"pass",Package:"example/b",Test:"TestExample"});
  writeFileSync(go,"#!/bin/sh\nprintf '%s\\n' '"+skipped+"'\n",{mode:0o755});
  expect(cmd().exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  writeFileSync(go,"#!/bin/sh\nprintf '%s\\n' '"+skipped+"' '"+passed+"'\n");
  expect(cmd().exitCode).toBe(0);
  expect(f.evidence()[0].status).toBe("pass");
});
test("verbose TypeScript build checks the pinned project", () => {
  writeFileSync(join(f.repo,"tsconfig.json"),JSON.stringify({files:["app.ts"],compilerOptions:{outDir:"out"}}));
  writeFileSync(join(f.repo,"app.ts"),"export const answer: number = 42;");
  writeFileSync(join(f.repo,".gitignore"),"out/\n");
  f.git("add",".");f.git("commit","-m","build project");
  const tsc = join(import.meta.dir,"../node_modules/.bin/tsc");
  expect(verify("build",tsc,"-b","--dry").exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  expect(verify("build",tsc,"-b","--dry","false").exitCode).toBe(0);
  expect(f.evidence()[0]).toMatchObject({kind:"build", status:"pass"});
  const res=verify("build",tsc,"-b","-v");
  expect(res.exitCode,res.stdout.toString()).toBe(0);
  expect(f.evidence()[0].kind).toBe("build");
});

test("verbose mypy lint executes the runner", () => {
  const mypy=join(f.root,"mypy");
  writeFileSync(mypy,'#!/bin/sh\n[ "$1" = "-v" ] && [ -f "$2" ]\n',{mode:0o755});
  expect(verify("lint",mypy,"-v","code.txt").exitCode).toBe(0);
  expect(f.evidence()[0].kind).toBe("lint");
});

test("inherited collection-only pytest options earn no explicit or automatic test credit", () => {
  writeFileSync(join(f.repo,"test_example.py"),"def test_example(): assert True\n");
  f.git("add",".");f.git("commit","-m","python tests");
  const bin=join(f.root,"tools");mkdirSync(bin);
  writeFileSync(join(bin,"pytest"),"#!/bin/sh\nprintf '1 test collected in 0.01s\\n'\n",{mode:0o755});
  const env={PATH:bin+":"+process.env.PATH,PYTEST_ADDOPTS:"--co"};
  for (const args of [["--kind","test","--","pytest"],["--mode","dynamic"]]) {
    expect(f.cli("wb-verify",args,env).exitCode).toBe(1);
  }
  expect(f.evidence()).toEqual([]);
});

test("package scripts collecting pytest tests never credit the task", () => {
  writeFileSync(join(f.repo,"package.json"),JSON.stringify({scripts:{test:"pytest"}}));
  writeFileSync(join(f.repo,"app.ts"),"export {};");
  const bin=join(f.root,"tools");mkdirSync(bin);
  writeFileSync(join(bin,"pytest"),"#!/bin/sh\nprintf '1/2 tests collected (1 deselected) in 0.01s\\n'\n",{mode:0o755});
  f.git("add",".");f.git("commit","-m","delegated test runner");
  const env={PATH:bin+":"+process.env.PATH,PYTEST_ADDOPTS:"--collectonly"};
  for (const args of [["--kind","test","--","npm","--no-color","run","test"],["--mode","dynamic"]]) {
    expect(f.cli("wb-verify",args,env).exitCode).toBe(1);
  }
  expect(f.evidence()).toEqual([]);
});

test("automatic npm verification refuses usage-only configuration", () => {
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }));
  f.git("add", ".");
  f.git("commit", "-m", "package tests");
  expect(f.cli("wb-verify", ["--mode", "dynamic"], {npm_config_usage: "true"}).exitCode).toBe(1);
  expect(f.evidence().map(e => e.status)).toEqual(["fail"]);
});

test("npm verification executes the selected script despite project usage configuration", () => {
  writeFileSync(join(f.repo, ".npmrc"), "usage=true\n");
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }));
  f.git("add", ".");
  f.git("commit", "-m", "npm project configuration");
  for (const args of [["--mode", "dynamic"], ["--kind", "test", "--", "npm", "run", "test"]]) {
    expect(f.cli("wb-verify", args).exitCode).toBe(1);
  }
  expect(f.evidence().map(e => e.status)).toEqual(["fail", "fail"]);
});

test("package scripts execute delegated Go tests with direct and saved dry-run settings", () => {
  const settings = join(f.root, "go-env");
  writeFileSync(settings, "GOFLAGS=-n\n");
  writeFileSync(join(f.root, "go"), "#!/bin/sh\nif [ \"$1\" = env ]; then sed -n 's/^GOFLAGS=//p' \"$GOENV\"; else case \"${GOFLAGS:--n}\" in *-n*) exit 0;; *) exit 1;; esac; fi\n", {mode: 0o755});
  mkdirSync(join(f.repo, "service"));
  writeFileSync(join(f.repo, "service/go.mod"), "module example\n");
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({scripts:{test:"cd service && go test ./..."}}));
  f.git("add", ".");
  f.git("commit", "-m", "delegated Go suite");
  for (const flags of ["-n", "'-n'", '"-n"', ""]) {
    const env = {GOFLAGS: flags, GOENV: settings, PATH:f.root + ":" + process.env.PATH};
    for (const args of [["--mode", "dynamic"], ["--kind", "test", "--", "npm", "run", "test"]]) {
      expect(f.cli("wb-verify", args, env).exitCode).toBe(1);
    }
  }
  expect(f.evidence().map(e => e.status)).toEqual(Array(8).fill("fail"));
});

test("pytest version output from project configuration earns no test credit", () => {
  writeFileSync(join(f.repo, "pytest.ini"), "[pytest]\naddopts = -VV\n");
  writeFileSync(join(f.repo, "test_sample.py"), "def test_sample(): assert True\n");
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({scripts:{test:"pytest"}}));
  const runner = join(f.root, "pytest");
  writeFileSync(runner, "#!/bin/sh\ngrep -q -- -VV pytest.ini || exit 2\necho 'This is pytest version 9.0, imported from /fixture/pytest/__init__.py'\n", {mode: 0o755});
  f.git("add", ".");
  f.git("commit", "-m", "verbose pytest installation query");
  for (const args of [["--kind", "test", "--", runner], ["--mode", "dynamic"], ["--kind", "test", "--", "npm", "run", "test"]]) {
    expect(f.cli("wb-verify", args, {PATH:f.root + ":" + process.env.PATH}).exitCode).toBe(1);
  }
  expect(f.evidence()).toEqual([]);
});

test("quiet pytest collection requires a call-phase report in direct and delegated runs", () => {
  writeFileSync(join(f.repo, "pytest.ini"), "[pytest]\naddopts = --collect-only -qq\n");
  writeFileSync(join(f.repo, "test_sample.py"), "def test_sample(): assert True\n");
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({scripts:{test:"pytest"}}));
  const runner = join(f.root, "pytest");
  writeFileSync(runner, `#!/usr/bin/env python3
import importlib
import os
import sys
from pathlib import Path
from types import SimpleNamespace

plugin = importlib.import_module(os.environ["PYTEST_PLUGINS"].split(",")[-1])
if "--collect-only" in Path("pytest.ini").read_text():
    print("test_sample.py: 1")
else:
    paths = os.environ.get("TEST_ITEMS", "test_sample.py").split(",")
    paths.extend(arg for arg in sys.argv[1:] if arg.endswith(".py"))
    for path in paths:
        plugin.pytest_runtest_call(SimpleNamespace(fspath=path))
    plugin.pytest_runtest_logreport(SimpleNamespace(when="call"))
    print(".")
`, {mode: 0o755});
  f.git("add", ".");
  f.git("commit", "-m", "quiet pytest collection");
  const env = {PATH:f.root + ":" + process.env.PATH};
  const commands = [["--kind", "test", "--", runner], ["--mode", "dynamic"], ["--kind", "test", "--", "npm", "run", "test"]];
  for (const args of commands) expect(f.cli("wb-verify", args, env).exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  writeFileSync(join(f.repo, "pytest.ini"), "[pytest]\naddopts = -qq\n");
  f.git("commit", "-am", "execute tests quietly");
  for (const args of commands) expect(f.cli("wb-verify", args, env).exitCode).toBe(0);
  expect(f.evidence().map(e=>e.status)).toEqual(["pass", "pass", "pass"]);
  const outside = join(f.root, "test_sibling.py");
  writeFileSync(outside, "def test_sibling(): pass\n");
  const mixed = {...env, TEST_ITEMS:"test_sample.py," + outside};
  expect(f.cli("wb-verify", ["--kind","test","--",runner], mixed).exitCode).toBe(1);
  expect(f.cli("wb-verify", ["--kind","test","--","npm","run","test","--",outside], env).exitCode).toBe(1);
  expect(f.evidence().slice(-2).map(e=>e.status)).toEqual(["fail","fail"]);
});

test("Go vet accepts diagnostic context while Go test rejects compile-only mode", () => {
  const go = join(f.root, "go");
  writeFileSync(go, "#!/bin/sh\ncase \"$1\" in env) exit 0;; vet) [ \"$2\" = -c=2 ];; *) exit 1;; esac\n", {mode: 0o755});
  expect(verify("test", go, "test", "-c").exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  expect(verify("lint", go, "vet", "-c=2", "./...").exitCode).toBe(0);
  expect(f.evidence()[0]).toMatchObject({kind: "lint", status: "pass"});
});

test("tsc implicit project discovery must stay inside the checkout", () => {
  const tsc = join(import.meta.dir, "../node_modules/.bin/tsc");
  writeFileSync(join(f.root, "tsconfig.json"), JSON.stringify({files:["parent.ts"]}));
  writeFileSync(join(f.root, "parent.ts"), "export const valid = true;");
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({scripts:{typecheck:"tsc --noEmit", lint:"npm run typecheck"}}));
  f.git("add", "."); f.git("commit", "-m", "delegated compiler");
  const env = {PATH:join(import.meta.dir, "../node_modules/.bin") + ":" + process.env.PATH};
  expect(verify("lint", tsc, "--noEmit").exitCode).toBe(1);
  expect(verify("lint", tsc, "-p", "../tsconfig.json").exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  for (const script of ["typecheck", "lint"])
    expect(f.cli("wb-verify", ["--kind","lint","--","npm","run",script], env).exitCode).toBe(1);
  expect(f.evidence().map(e=>e.status)).toEqual(["fail","fail"]);
  writeFileSync(join(f.repo, "app.ts"), "export const valid = true;");
  f.git("add", "app.ts");
  f.git("commit", "-m", "local source file");
  expect(verify("lint", tsc, "--noEmit", "app.ts").exitCode).toBe(0);
  writeFileSync(join(f.repo, "tsconfig.json"), JSON.stringify({files:["app.ts"]}));
  f.git("add", "."); f.git("commit", "-m", "local compiler configuration");
  expect(f.cli("wb-verify", ["--kind","lint","--","npm","run","lint"], env).exitCode).toBe(0);
  expect(f.evidence().map(e=>e.status)).toEqual(["fail","fail","pass","pass"]);
});

test("Cargo verification credits only manifests and workspace packages in the checkout", () => {
  const runner = join(f.root, "cargo");
  writeFileSync(runner, `#!/usr/bin/env python3
import json, sys
from pathlib import Path
if sys.argv[1] == "metadata":
    path = Path(sys.argv[-1])
    packages = [{"manifest_path": str(path)}]
    if "outside" in path.read_text():
        packages.append({"manifest_path": str(Path.cwd().parent / "Cargo.toml")})
    print(json.dumps({"packages": packages}))
`, {mode: 0o755});
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({scripts:{test:"cargo test"}}));
  f.git("add",".");
  f.git("commit","-m","delegated cargo tests");
  const env = {PATH:f.root + ":" + process.env.PATH};
  const delegated = [["--kind","test","--","npm","run","test"], ["--mode","dynamic"]];
  writeFileSync(join(f.root, "Cargo.toml"), "[workspace]\n");
  for (const args of [[], ["--manifest-path", "../Cargo.toml"], ["--manifest-path=../Cargo.toml"]]) {
    expect(verify("test", runner, "test", ...args).exitCode).toBe(1);
  }
  expect(f.evidence()).toEqual([]);
  for (const args of delegated) expect(f.cli("wb-verify", args, env).exitCode).toBe(1);
  expect(f.evidence().map(e=>e.status)).toEqual(["fail","fail"]);
  writeFileSync(join(f.repo, "Cargo.toml"), "# outside member\n");
  f.git("add", "."); f.git("commit", "-m", "workspace");
  expect(verify("test", runner, "test", "--workspace").exitCode).toBe(1);
  expect(f.evidence().every(e => e.status === "fail")).toBe(true);
  writeFileSync(join(f.repo, "Cargo.toml"), "[package]\nname = 'local'\nversion = '0.1.0'\n");
  f.git("commit", "-am", "local crate");
  expect(verify("test", runner, "test", "--manifest-path", "Cargo.toml").exitCode).toBe(0);
  for (const args of delegated) expect(f.cli("wb-verify", args, env).exitCode).toBe(0);
  expect(f.evidence().map(e=>e.status)).toEqual(["fail","fail","pass","pass","pass"]);
});

test("explicit test inputs stay in the pinned checkout", () => {
  const sibling = join(f.root, "sibling");
  mkdirSync(sibling);
  const outside = join(sibling, "other_test.py");
  writeFileSync(outside, "def test_other(): pass\n");
  writeFileSync(join(f.repo, "local.test.js"), 'require("node:test").test("local", () => {});');
  symlinkSync(sibling, join(f.repo, "linked"));
  f.git("add","."); f.git("commit","-m","test inputs");
  const marker = join(f.root, "launched");
  for (const [bin, prefix] of [["pytest", []], ["jest", []], ["vitest", ["run"]], ["bun", ["test"]], ["node", ["--test"]]] as const) {
    const runner = join(f.root, bin);
    writeFileSync(runner, "#!/bin/sh\ntouch \"$MARKER\"\n", {mode:0o755});
    for (const input of [outside, "linked/other_test.py", "../sibling"]) {
      const args = ["--kind","test","--",runner,...prefix,input + (bin === "pytest" && input === outside ? "::test_other" : "")];
      expect(f.cli("wb-verify", args, {MARKER:marker}).exitCode).toBe(1);
    }
  }
  expect(existsSync(marker)).toBe(false);
  expect(f.evidence()).toEqual([]);
  expect(verify("test", "node", "--test", "--test-name-pattern", "local", "local.test.js").exitCode).toBe(0);
  expect(f.evidence()[0]).toMatchObject({kind:"test",status:"pass"});
});

test("make build evidence requires a build goal or a build default", () => {
  const makefile = join(f.repo, "Makefile");
  writeFileSync(makefile, "clean:\n\t@echo clean\nbuild:\n\t@echo build\n");
  f.git("add","."); f.git("commit","-m","cleanup default");
  for (const args of [[],["clean"],["build","clean"],["fmt"],["--","distclean"]]) {
    expect(verify("build","make",...args).exitCode).toBe(1);
  }
  expect(f.evidence()).toEqual([]);
  writeFileSync(makefile, "all: code.txt\n");
  f.git("commit","-am","prerequisite without a recipe");
  expect(verify("build","make","all").exitCode).toBe(1);
  expect(verify("build","make").exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  writeFileSync(makefile, "all: app.o\napp.o: code.txt\n\t@echo compile\n");
  f.git("commit","-am","prerequisite with a recipe");
  expect(verify("build","make").exitCode).toBe(0);
  writeFileSync(makefile, ".PHONY: build clean\n.DEFAULT_GOAL := build\nclean:\n\t@echo clean\nbuild:\n\t@echo build\n");
  f.git("commit","-am","build default");
  expect(verify("build","make").exitCode).toBe(0);
  expect(verify("build","make","-j4").exitCode).toBe(0);
  expect(verify("build","make","build").exitCode).toBe(0);
  expect(f.evidence().map(e=>e.status)).toEqual(["pass","pass","pass","pass"]);
});

test("Go and Cargo require an executed test across the suite", () => {
  writeFileSync(join(f.repo,"Cargo.toml"), "[package]\nname='local'\nversion='0.1.0'\n");
  writeFileSync(join(f.repo,"go.mod"), "module local\n");
  f.git("add","."); f.git("commit","-m","test packages");
  const go = join(f.root,"go"), cargo = join(f.root,"cargo");
  writeFileSync(go, '#!/bin/sh\n[ "$1" = env ] || printf "%s\\n" "$SUITE"\n', {mode:0o755});
  writeFileSync(cargo, '#!/bin/sh\nif [ "$1" = metadata ]; then printf \'{"packages":[{"manifest_path":"%s/Cargo.toml"}]}\\n\' "$PWD"; else printf "%s\\n" "$SUITE"; fi\n', {mode:0o755});
  const verifySuite = (bin:string, output:string) => f.cli("wb-verify",["--kind","test","--",bin,"test"],{SUITE:output});
  const emptyGo = "ok  example/unused  0.01s [no tests to run]";
  const emptyCargo = "running 0 tests\ntest result: ok. 0 passed; 0 failed";
  expect(verifySuite(go, emptyGo).exitCode).toBe(1);
  expect(f.cli("wb-verify", ["--mode","dynamic"], {SUITE:emptyGo, PATH:f.root + ":" + process.env.PATH}).exitCode).toBe(1);
  const ignored = "running 1 test\ntest result: ok. 0 passed; 0 failed; 1 ignored";
  expect(verifySuite(cargo, ignored).exitCode).toBe(1);
  const node = join(f.root, "node");
  writeFileSync(node, '#!/bin/sh\nprintf "%s\\n" "$SUITE"\n', {mode:0o755});
  for (const summary of ["# tests 0", "# pass 0\n# fail 0"]) {
    expect(f.cli("wb-verify",["--kind","test","--",node,"--test"],{SUITE:summary}).exitCode).toBe(1);
  }
  expect(verifySuite(cargo, emptyCargo).exitCode).toBe(1);
  expect(verifySuite(cargo, "0 passed; 0 failed").exitCode).toBe(1);
  expect(f.evidence()).toEqual([]);
  expect(verifySuite(go, emptyGo + "\nok  example/tested  0.03s").exitCode).toBe(0);
  expect(verifySuite(cargo, ignored + "\nrunning 1 test\ntest result: ok. 1 passed; 0 failed").exitCode).toBe(0);
  expect(f.evidence().map(e=>e.status)).toEqual(["pass","pass"]);
});
