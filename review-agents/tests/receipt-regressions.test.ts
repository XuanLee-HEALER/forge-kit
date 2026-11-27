import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Entry = {status:string; oldPath:string; path:string; added:number; deleted:number};
type Call = {role:string; index:{changes:Entry[]}; chunks:{path:string;patch:string;newEnd:number;oldEnd:number}[];spec:string|null};
function fixture(run: (f: ReturnType<typeof setup>) => void) {
  const root = mkdtempSync(join(tmpdir(), "receipt-test-"));
  try { run(setup(root)); } finally { rmSync(root, {recursive:true,force:true}); }
}
function setup(root:string) {
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args:string[]) => {
    const p = Bun.spawnSync(["git","-C",repo,"-c","user.name=Fixture","-c","user.email=fixture@example.invalid", ...args]);
    expect(p.exitCode, p.stderr.toString()).toBe(0);
    return p.stdout.toString().trim();
  };
  git("init", "-q");
  const fake = join(root,"codex");
  writeFileSync(fake, `#!/usr/bin/env bun
import {appendFileSync,readFileSync} from "node:fs";
const q=JSON.parse(await Bun.stdin.text()), line=Number(readFileSync(import.meta.path+".line","utf8"));
appendFileSync(import.meta.path+".calls",JSON.stringify(q)+"\\n");
const checked=q.chunks.map(({id,path})=>({id,path,conclusion:"reviewed"}));
const findings=line?[{severity:"blocking",path:"code.ts",line,title:"anchored",evidence:"fixture",recommendation:"fix"}]:[];
await Bun.write(process.argv[process.argv.indexOf("-o")+1],JSON.stringify({role:q.role,checked,findings,status:"pass",summary:"fixture",limitations:[]}));
`, {mode:0o755});
  const review = (base:string, roles:string, line = 0, spec = "", path = process.env.PATH) => {
    writeFileSync(fake+".line", String(line));
    writeFileSync(fake+".calls", "");
    const p = Bun.spawnSync([process.execPath,join(import.meta.dir,"../src/review.ts"),"--repo",repo,"--base",base,
      "--head","HEAD","--roles",roles,"--model","gpt-6.2-sol","--effort","medium", ...(spec ? ["--spec",spec] : [])],
      {env:{PATH:path, HOME:root, FORGE_CODEX_BIN:fake}, timeout:90_000});
    expect(p.stderr.toString()).toBe("");
    const calls:Call[] = readFileSync(fake+".calls","utf8").trim().split("\n").filter(Boolean).map(l=>JSON.parse(l));
    return {code:p.exitCode, calls, report:JSON.parse(p.stdout.toString())};
  };
  const commit = (message:string) => { git("commit","-qm",message); return git("rev-parse","HEAD"); };
  return {root,repo,git,review,commit};
}

test("the large review delivers the entire Git inventory and pure rename metadata to each role", () => fixture(f => {
  const deleted = Array.from({length:60}, (_,i) => "old-"+i+".txt");
  let deletedBytes = 0;
  for (const path of deleted) {
    const text = (path+"abcdefghijklmnop\n").repeat(1200);
    writeFileSync(join(f.repo,path), text);
    deletedBytes += Buffer.byteLength(text);
  }
  expect(deletedBytes).toBeGreaterThan(1_572_864);
  writeFileSync(join(f.repo,"original.txt"), "unique rename\n");
  writeFileSync(join(f.repo,"code.ts"), "export const original = 1;\n");
  f.git("add","--",...deleted,"original.txt","code.ts");
  const base = f.commit("base");
  f.git("rm","-q","--",...deleted);
  f.git("mv","original.txt","renamed.txt");
  const added = [...Array.from({length:17},(_,i)=>"new-"+i+".txt"), "code.test.ts"];
  for (const path of added) writeFileSync(join(f.repo,path), path+"\n");
  writeFileSync(join(f.repo,"code.ts"),"export const changed = 2;\n");
  f.git("add","--",...added,"code.ts");
  f.commit("large range");
  const rows = f.git("diff","-M","--name-status",base,"HEAD").split("\n").map(line=>{
    const [status,oldPath,newPath] = line.split("\t");
    return {status,oldPath,path:newPath ?? oldPath};
  });
  expect(rows).toHaveLength(80);
  const {code,calls} = f.review(base,"quality,comments");
  expect(code).toBe(0);
  for (const role of ["quality","comments"]) {
    const batches = calls.filter(c=>c.role === role);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.index.changes.map(({status,oldPath,path})=>({status,oldPath,path}))).toEqual(rows);
    }
    const chunks = batches.flatMap(c=>c.chunks);
    expect(new Set(chunks.map(c=>c.path))).toEqual(new Set(rows.map(r=>r.path)));
    const rename = chunks.filter(c=>c.path === "renamed.txt");
    expect(rename).toHaveLength(1);
    expect(JSON.parse(rename[0].patch)).toMatchObject({status:"R100",oldPath:"original.txt",path:"renamed.txt"});
  }
}), 120_000);

test("cross-boundary renames expose only complete public additions and deletions", () => fixture(f => {
  mkdirSync(join(f.repo,".workbench"));
  for (const [file, prefix, unique] of [[".workbench/origin.txt","incoming","PRIVATE_IN"],["outgoing.txt","leaving","PUBLIC_OUT"]]) {
    writeFileSync(join(f.repo,file), (prefix+" shared line\n").repeat(30)+unique+"\n");
  }
  f.git("add","--",".workbench/origin.txt","outgoing.txt");
  const base = f.commit("base");
  renameSync(join(f.repo,".workbench/origin.txt"),join(f.repo,"incoming.txt"));
  renameSync(join(f.repo,"outgoing.txt"),join(f.repo,".workbench/dest.txt"));
  writeFileSync(join(f.repo,"incoming.txt"), "incoming shared line\n".repeat(30)+"PUBLIC_IN\n");
  writeFileSync(join(f.repo,".workbench/dest.txt"), "leaving shared line\n".repeat(30)+"PRIVATE_OUT\n");
  f.git("add","--",".workbench","incoming.txt","outgoing.txt");
  f.commit("renames");
  expect(f.git("diff","-M","--name-status",base,"HEAD").match(/^R/gm)).toHaveLength(2);
  const {code,calls,report} = f.review(base,"quality");
  expect(code).toBe(3);
  expect(report.roles[0].missing_materials.toSorted()).toEqual([".workbench/dest.txt",".workbench/origin.txt"]);
  const payload = JSON.stringify(calls);
  expect(payload).not.toMatch(/PRIVATE_OUT|PRIVATE_IN|\.workbench\/(?:origin|dest)/);
  expect(calls[0].index.changes).toEqual(expect.arrayContaining([
    expect.objectContaining({status:"A",path:"incoming.txt",added:31,deleted:0}),
    expect.objectContaining({status:"D",path:"outgoing.txt",added:0,deleted:31}),
  ]));
  expect(calls[0].chunks.map(c=>c.patch).join("")).toContain("+PUBLIC_IN");
  expect(calls[0].chunks.map(c=>c.patch).join("")).toContain("-PUBLIC_OUT");
}));

test("actual prompt budget, pinned context errors and old-side finding anchors", () => fixture(f => {
  const lines = Array.from({length:125}, (_,i)=>"const value"+i+" = "+i+";\n");
  writeFileSync(join(f.repo,"code.ts"),lines.join(""));
  f.git("add","--","code.ts");
  const base = f.commit("base");
  lines.splice(109, 0, "// inserted in second hunk\n");
  lines.splice(0, 6);
  writeFileSync(join(f.repo,"code.ts"),lines.join(""));
  f.git("add","--","code.ts");
  f.commit("two hunks");
  const spec = join(f.root,"spec.md");
  writeFileSync(spec, "a".repeat(61_000));
  const clean = f.review(base,"quality",0,spec);
  expect(clean.code).toBe(0);
  expect(clean.calls[0].spec?.length).toBe(61_000);
  const later = clean.calls.flatMap(c=>c.chunks).find(c=>c.patch.includes("inserted in second hunk"))!;
  expect(later.oldEnd).toBeGreaterThan(later.newEnd);
  expect(f.review(base,"quality",later.oldEnd,spec).code).toBe(3);
  writeFileSync(spec, "begin"+"\u000b".repeat(30_000)+"endspec");
  const tooBig = f.review(base,"quality",0,spec);
  expect(tooBig.code).toBe(3);
  expect(tooBig.report.roles[0].limitations.join(" ")).toContain("Prompt budget exceeded");
  expect(tooBig.calls).toHaveLength(0);

  // Remove the file so a line exists only on the deleted side.
  f.git("rm","--","code.ts"); f.commit("delete");
  // A blocking finding overrides the simulated reviewer's own pass verdict.
  const blocked = f.review(base,"quality",120);
  expect(blocked.code).toBe(1);
  expect(blocked.report.roles[0].status).toBe("blocked");

  const actualGit = Bun.which("git")!;
  writeFileSync(join(f.root,"git"),'#!/bin/sh\nfor arg do [ "$arg" = ls-tree ] && exit 17; done\nexec "' + actualGit + '" "$@"\n',{mode:0o755});
  const failedContext = f.review(base,"quality",120,"",f.root+":"+process.env.PATH);
  expect(failedContext.code).toBe(3);
  expect(failedContext.report.roles[0].missing_materials).toContain("code.ts");
  expect(failedContext.report.roles[0].findings).toHaveLength(1);
  expect(failedContext.report.roles[0].attempts[0].status).toBe("incomplete");
  expect(failedContext.report.roles[0].limitations.join(" ")).toContain("pinned caller");
}), 30_000);
