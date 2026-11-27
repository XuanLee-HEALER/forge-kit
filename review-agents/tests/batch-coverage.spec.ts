import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Entry = {status:string; oldPath:string; path:string; added:number; deleted:number};
type Call = {role:string; context:{revision:string;files:{path:string;text:string}[]}; related:(Entry & {position:number})[]; index:{files:number; excluded:number; digest:string; changes?:Entry[]; pages?:{offset:number;count:number}[]}; chunks:{id:string;path:string;patch:string;newEnd:number;oldEnd:number}[];spec:string|null};
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
import {appendFileSync,readFileSync,readdirSync,unlinkSync,writeFileSync} from "node:fs";
import {join} from "node:path";
const q=JSON.parse(await Bun.stdin.text()), line=Number(readFileSync(import.meta.path+".line","utf8"));
appendFileSync(import.meta.path+".calls",JSON.stringify(q)+"\\n");
const checked=q.chunks.map(({id,path})=>({id,path,conclusion:"reviewed"}));
const mode=readFileSync(import.meta.path+".mode","utf8");
if (mode==="duplicate") checked.push(checked[0]);
if (mode==="invalid") checked[0].id="0-bad";
if (mode==="drop" && q.chunks.some(c=>c.path==="code.ts")) {
  let remove = false;
  try { writeFileSync(import.meta.path+".drop","",{flag:"wx"}); remove=true; }
  catch (e) { if (e.code!=="EEXIST") throw e; }
  if (remove) {
    const root = ${JSON.stringify(root)};
    const dir = join(root,readdirSync(root).find(name=>name.startsWith("forge-review-material-")));
    const id = readdirSync(dir).find(name=>/^[a-f0-9]{64}$/.test(name) && readFileSync(join(dir,name),"utf8").includes("MISSING_FIXTURE_CHUNK"));
    unlinkSync(join(dir,id));
  }
}
const findings=line && q.chunks.some(c=>c.path==="code.ts")?[{severity:"blocking",path:"code.ts",line,title:"anchored",evidence:"fixture",recommendation:"fix"}]:[];
await Bun.write(process.argv[process.argv.indexOf("-o")+1],JSON.stringify({role:q.role,checked,findings,status:"pass",summary:"fixture",limitations:[]}));
`, {mode:0o755});
  const review = (base:string, roles:string, line = 0, spec = "", path = process.env.PATH, mode = "valid") => {
    writeFileSync(fake+".mode",mode);
    writeFileSync(fake+".line", String(line));
    writeFileSync(fake+".calls", "");
    const p = Bun.spawnSync([process.execPath,join(import.meta.dir,"../src/review.ts"),"--repo",repo,"--base",base,
      "--head","HEAD","--roles",roles,"--model","gpt-6.2-sol","--effort","medium", ...(spec ? ["--spec",spec] : [])],
      {env:{PATH:path, HOME:root, TMPDIR:root, FORGE_CODEX_BIN:fake}, timeout:90_000});
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
  writeFileSync(join(f.repo,"code.ts"),"export const changed = 2; // MODIFIED_SOURCE\n");
  writeFileSync(join(f.repo,"code.test.ts"),"expect(changed).toBe(2); // NEW_TEST\n");
  f.git("add","--",...added,"code.ts");
  const head = f.commit("large range");
  const original = f.git("show",base+":code.ts");
  const modified = f.git("show",head+":code.ts");
  const addedTest = f.git("show",head+":code.test.ts");
  writeFileSync(join(f.repo,"code.ts"),"DIRTY_WORKTREE_ONLY\n");
  writeFileSync(join(f.repo,"code.test.ts"),"DIRTY_WORKTREE_ONLY\n");
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
      expect(batch.index.changes!.map(({status,oldPath,path})=>({status,oldPath,path}))).toEqual(rows);
    }
    const chunks = batches.flatMap(c=>c.chunks);
    expect(new Set(chunks.map(c=>c.path))).toEqual(new Set(rows.map(r=>r.path)));
    const patchLines = (path:string) => chunks.filter(c=>c.path === path).flatMap(c=>c.patch.split("\n"));
    expect(patchLines("code.ts")).toEqual(expect.arrayContaining(["-"+original,"+"+modified]));
    expect(patchLines("code.test.ts")).toContain("+"+addedTest);
    expect(chunks.some(c=>c.patch.includes("DIRTY_WORKTREE_ONLY"))).toBe(false);
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

test("long Git paths fit the global index and exact compact receipts remain mandatory", () => fixture(f => {
  // Construct the Git tree without checking it out. Its paths exceed the
  // host filesystem limit and are still valid at the pinned commit.
  f.git("commit","--allow-empty","-qm","base");
  const base = f.git("rev-parse","HEAD");
  const blob = f.git("hash-object","-w","--stdin");
  const parent = ("a".repeat(80)+"/").repeat(32);
  const paths = Array.from({length:80}, (_,i)=>parent+"item-"+i+".txt");
  const add = Bun.spawnSync(["git","-C",f.repo,"update-index","--index-info"],{
    stdin:Buffer.from(paths.map(path=>"100644 "+blob+"\t"+path+"\n").join("")),
  });
  expect(add.exitCode,add.stderr.toString()).toBe(0);
  f.commit("long paths");
  const result = f.review(base,"quality");
  expect(result.code).toBe(0);
  const ids = result.calls.flatMap(call=>call.chunks.map(chunk=>chunk.id));
  expect(new Set(ids).size).toBe(80);
  expect(ids.every(id=>/^\d{1,2}-[a-f0-9]{4}$/.test(id))).toBe(true);
  expect(new Set(result.calls.flatMap(c=>c.chunks.map(chunk=>chunk.path)))).toEqual(new Set(paths));
  for (const call of result.calls) {
    expect(Buffer.byteLength(JSON.stringify(call.index))).toBeLessThanOrEqual(20_000);
    const manifest = [...paths].sort();
    for (const entry of call.related) {
      expect(entry.path).toBe(manifest[entry.position]);
      expect(call.index.pages!.some(p=>p.offset<=entry.position && entry.position<p.offset+p.count)).toBe(true);
    }
    expect(result.report.roles[0].coverage.inventory_digest).toBe(call.index.digest);
    const pages = call.index.pages!;
    let offset = 0;
    for (const page of pages) {
      expect(page.offset).toBe(offset);
      offset += page.count;
    }
    expect(offset).toBe(paths.length);
  }
  for (const mode of ["duplicate","invalid"]) {
    const invalid = f.review(base,"quality",0,"",process.env.PATH,mode);
    expect(invalid.code).toBe(3);
    expect(invalid.calls).toHaveLength(1);
    const {coverage} = invalid.report.roles[0];
    expect(coverage.reviewed).toBe(0);
    expect(coverage.missing).toHaveLength(80);
    const first = invalid.calls[0].chunks[0];
    const missing = coverage.missing.find((chunk:{path:string})=>chunk.path===first.path);
    expect(missing.id).toMatch(/^[0-9a-f]{64}$/);
    expect(first.id.endsWith("-"+missing.id.slice(0,4))).toBe(true);
  }
}), 60_000);

test("an unavailable material directory returns incomplete selections for the pinned range", () => fixture(f => {
  f.git("commit","--allow-empty","-qm","base");
  const base = f.git("rev-parse","HEAD");
  for (const path of ["a.txt","b.txt"]) writeFileSync(join(f.repo,path),path+"\n");
  f.git("add","--","a.txt","b.txt");
  const head = f.commit("changes");
  const tmp = join(f.root,"not-a-directory");
  writeFileSync(tmp,"");
  const result = Bun.spawnSync([process.execPath,join(import.meta.dir,"../src/review.ts"),"--repo",f.repo,
    "--base",base,"--head",head,"--roles","quality,comments","--mode","ordered","--order","comments,quality",
    "--model","gpt-6.2-sol","--effort","medium"],{env:{PATH:process.env.PATH,TMPDIR:tmp,HOME:f.root,FORGE_CODEX_BIN:join(f.root,"codex")}});
  expect(result.exitCode,result.stderr.toString()).toBe(3);
  const report = JSON.parse(result.stdout.toString());
  expect(report).toMatchObject({status:"incomplete",base,head,mode:"ordered"});
  expect(report.roles.map((r:{role:string})=>r.role)).toEqual(["comments","quality"]);
  for (const role of report.roles) {
    expect(role).toMatchObject({base,head,status:"incomplete",backend:null,attempts:[],findings:[],
      coverage:{reviewed:0},missing_materials:["a.txt","b.txt"]});
    expect(role.limitations.join(" ")).toMatch(/temporary material directory.*ENOTDIR/i);
  }
}));

test("a lost prepared chunk preserves findings and the remaining material for each role", () => fixture(f => {
  f.git("commit","--allow-empty","-qm","base");
  const base = f.git("rev-parse","HEAD");
  const paths = ["code.ts", ...Array.from({length:35}, (_,i)=>"part-"+i+".txt"), "zz-lost.txt", "zz-sent.txt"];
  for (const path of paths) writeFileSync(join(f.repo,path),path==="zz-lost.txt"?"MISSING_FIXTURE_CHUNK\n":path+"\n");
  f.git("add","--",...paths); f.commit("chunks");
  const result = f.review(base,"quality,comments",1,"",process.env.PATH,"drop");
  expect(result.code).toBe(3);
  for (const role of result.report.roles) {
    expect(role.status).toBe("incomplete");
    expect(role.missing_materials).toEqual(["zz-lost.txt"]);
    expect(role.coverage.reviewed).toBe(paths.length-1);
    expect(role.coverage.missing).toEqual([{id:expect.stringMatching(/^[a-f0-9]{64}$/),path:"zz-lost.txt"}]);
    expect(role.findings).toHaveLength(1);
    expect(role.limitations.join(" ")).toMatch(/Cannot read pinned chunk.*zz-lost.txt.*ENOENT/);
    expect(result.calls.some(c=>c.role===role.role && c.chunks.some(k=>k.path==="zz-sent.txt"))).toBe(true);
  }
}));

test("local attribute overrides cannot hide a pinned text deletion or force review of a pinned binary", () => fixture(f => {
  writeFileSync(join(f.repo,".gitattributes"),"binary.txt -diff\n");
  for (const path of ["deleted.txt","binary.txt"]) writeFileSync(join(f.repo,path),path+" witness\n");
  f.git("add","--",".gitattributes","deleted.txt","binary.txt");
  const base = f.commit("attribute baseline");
  f.git("rm","--","deleted.txt","binary.txt"); f.commit("delete");
  const normal = f.review(base,"quality");
  expect(normal.code).toBe(3);
  expect(normal.report.roles[0].missing_materials).toEqual(["binary.txt"]);
  expect(normal.calls.flatMap(c=>c.chunks).map(k=>k.patch).join("")).toContain("-deleted.txt witness");
  writeFileSync(join(f.repo,".git/info/attributes"),"deleted.txt -diff\nbinary.txt diff\n");
  const override = f.review(base,"quality");
  expect(override.report).toEqual(normal.report);
  expect(override.calls).toEqual(normal.calls);
}));

test("related implementation and test hunks share a batch across the 32-chunk boundary", () => fixture(f => {
  mkdirSync(join(f.repo,"src"));
  mkdirSync(join(f.repo,"tests"));
  const lines = Array.from({length:500},(_,i)=>"// line "+i+"\n");
  writeFileSync(join(f.repo,"src/parser.ts"),lines.join(""));
  f.git("add","--","src/parser.ts");
  const base = f.commit("parser");
  for (let i=0;i<32;i++) lines[i*15]="// revised "+i+"\n";
  writeFileSync(join(f.repo,"src/parser.ts"),lines.join(""));
  writeFileSync(join(f.repo,"tests/parser.test.ts"),"// regression check\n");
  f.git("add","--","src/parser.ts","tests/parser.test.ts"); f.commit("32 hunks and a test");
  const result = f.review(base,"quality");
  expect(result.code).toBe(0);
  expect(result.calls).toHaveLength(2);
  expect(result.calls.flatMap(c=>c.chunks).filter(k=>k.path==="src/parser.ts")).toHaveLength(32);
  expect(result.calls.some(c=>["src/parser.ts","tests/parser.test.ts"].every(path=>c.chunks.some(k=>k.path===path)))).toBe(true);
}));

test("a single-chunk batch keeps its inventory identity when a large spec needs the summary", () => fixture(f => {
  f.git("commit","--allow-empty","-qm","base");
  const base = f.git("rev-parse","HEAD");
  writeFileSync(join(f.repo,"sample.txt"),"review this line\n");
  f.git("add","--","sample.txt"); f.commit("change");
  const initial = f.review(base,"quality");
  const prompt = initial.calls[0];
  const {files,excluded,digest} = prompt.index;
  const summary = {files,excluded,digest};
  const compactBytes = Buffer.byteLength(JSON.stringify({...prompt,spec:"",index:summary}));
  const spec = join(f.root,"requirements");
  writeFileSync(spec,"x".repeat(140_000-compactBytes-1));
  const result = f.review(base,"quality",0,spec);
  expect(result.code).toBe(0);
  expect(result.calls[0].index).toEqual(summary);
  expect(result.calls[0].related[0]).toMatchObject({path:"sample.txt",position:0});
  expect(result.report.roles[0].coverage).toMatchObject({inventory_digest:digest,inventory_files:1,expected:1,reviewed:1});
}));

test("other batches provide numbered dependency definitions and actual caller sites at the pinned head", () => fixture(f => {
  const dep = "aaa-library.ts", target = "mmm-service.ts", caller = "zzz-consumer.ts";
  const padding = Array.from({length:300}, (_,i)=>"// unchanged filler "+i+" "+".".repeat(40)).join("\n");
  const dependency = (value:number) => "export const unrelated = 0;\n"+padding+"\nexport function convertAmount(x:number) { return x * "+value+"; }\n";
  const service = (value:number) => 'import {convertAmount as convert} from "./aaa-library";\n'+padding+'\nexport function invoiceTotal(x:number) { return convert(x) + '+value+'; }\n';
  const consumer = (value:number) => 'import {\n invoiceTotal,\n} from "./mmm-service";\n'+padding+"\nexport const amount = invoiceTotal("+value+");\n";
  for (const [path, text] of [[dep,dependency(1)],[target,service(1)],[caller,consumer(1)]])
    writeFileSync(join(f.repo,path),text);
  f.git("add","--",dep,target,caller);
  const base = f.commit("baseline");
  for (const [path, text] of [[dep,dependency(2)],[target,service(2)],[caller,consumer(2)]])
    writeFileSync(join(f.repo,path),text);
  const filler = Array.from({length:64},(_,i)=>(i<32?"bbb":"nnn")+i+".txt");
  for (const path of filler) writeFileSync(join(f.repo,path),path+"\n");
  f.git("add","--",dep,target,caller,...filler);
  const head = f.commit("three separate batches");
  for (const path of [dep,target,caller]) writeFileSync(join(f.repo,path),"DIRTY WORKTREE\n");
  const result = f.review(base,"quality");
  expect(result.code).toBe(0);
  const call = result.calls.find(c=>c.chunks.some(k=>k.path===target))!;
  const delivered = new Set(call.chunks.map(k=>k.path));
  expect(delivered.has(dep) || delivered.has(caller)).toBe(false);
  expect(call.context.revision).toBe(head);
  const excerpts = call.context.files;
  expect(excerpts.some(e=>delivered.has(e.path))).toBe(false);
  expect(excerpts.find(e=>e.path===dep)?.text).toContain("302: export function convertAmount(x:number) { return x * 2; }");
  expect(excerpts.find(e=>e.path===caller)?.text).toContain("304: export const amount = invoiceTotal(2);");
  for (const e of excerpts) {
    expect(Buffer.byteLength(e.text)).toBeLessThanOrEqual(4096);
    expect(e.text).not.toContain("DIRTY WORKTREE");
  }
}));
