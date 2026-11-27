// Work only with pinned Git objects. Unknown contract forms invalidate the role
// conservatively. Named exports provide additional, individually checked caller sites.
import { posix } from "node:path";
import { createHash } from "node:crypto";
import { Repo, type Change, isPrivatePath } from "./repo";

const sourceGlobs = ["ts","tsx","mts","cts","js","jsx","mjs","cjs","py","go","rs","java","rb","c","cpp","h"].map(ext=>"*."+ext);
const hash = (items: Iterable<string>) => createHash("sha256").update(JSON.stringify([...items].sort())).digest("hex");

function addTo<K,V>(groups: Map<K,Set<V>>, key: K, value: V) {
  const group = groups.get(key);
  if (group) group.add(value);
  else groups.set(key,new Set([value]));
}

function surfaces(source: string) {
  const result = new Map<string,string[]>();
  const declarations = [...source.matchAll(/(?:^|(?<=[;}]))[ \t]*export\s+(?:(?:default|async|abstract|declare)\s+)*(function|class|interface|type|enum|const|let|var)(?:\s*\*\s*|\s+)([\w$]+)/gm)];
  for (const [i, match] of declarations.entries()) {
    const end = declarations[i+1]?.index ?? source.length;
    let text = source.slice(match.index, end).split(/\n(?=(?:import|const|class|function|interface|type|let|var)\s)/)[0].trim();
    // An explicit single-line function signature completely identifies its
    // declared call contract. Keep the whole declaration for inferred or
    // multiline shapes rather than overlooking an inferred return change.
    if (match[1] === "function") {
      const signature = /^[^\n]*\)\s*:\s*[^\n{]+\{/.exec(text);
      if (signature) text = signature[0];
    }
    const parts = result.get(match[2]) ?? [];
    parts.push(text);
    result.set(match[2], parts);
  }
  return new Map([...result].map(([name, parts])=>[name,parts.join("\n")]));
}

export function contractImpact(repo: Repo) {
  const uncertain = new Set<string>();
  const symbols = new Map<string,Set<string>>();
  const modules = new Map<string,Set<string>>();
  const signatures = new Map<string,{path:string; name:string; before:string; after:string}>();
  const namesByIdentity = new Map<string,string>();
  for (const c of repo.changes) {
    if (/\.(md|txt|rst)$/i.test(c.path)) continue;
    const identity = JSON.stringify([c.oldPath,c.path,c.oldOid,c.newOid]);
    const js = /\.[cm]?[jt]sx?$/i.test(c.path);
    if (!js) uncertain.add(identity);
    if (!sourceGlobs.some(glob=>c.path.endsWith(glob.slice(1)))) continue;
    try {
      const source = (oid:string) => /^0+$/.test(oid) ? "" : repo.git(["cat-file","blob",oid], false, 512 * 1024);
      const old = source(c.oldOid), head = source(c.newOid);
      const before = surfaces(old), after = surfaces(head);
      // Indirect, computed and unnamed exports are not statically bounded.
      if (c.path !== c.oldPath || /\bexport\s*(?:default\b|[={*])|module\.exports|\bexports\.|^\s*export\s+(?:namespace|import)\b/m.test(old+"\n"+head))
        uncertain.add(identity);
      if (!js) {
        for (const [declarations,source] of [[before,old],[after,head]] as const) {
          const revision = hash([source]);
          for (const m of source.matchAll(/^\s*(?:(?:pub|async)\s+)*(?:def|fn|func|class)\s+(\w+)/gm))
            declarations.set(m[1], m[0].trim()+" "+revision);
        }
      }
      const keys: string[] = [];
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(name) === after.get(name) && c.oldPath === c.path) continue;
        const key = hash([JSON.stringify([c.path,name,before.get(name),after.get(name)])]);
        signatures.set(key,{path:c.path,name,before:before.get(name)?.slice(0,500) ?? "",after:after.get(name)?.slice(0,500) ?? ""});
        keys.push(key);
        namesByIdentity.set(key,c.path);
        addTo(symbols,name,key);
      }
      if (uncertain.has(identity)) {
        keys.push(identity);
        namesByIdentity.set(identity,c.path);
      }
      if (keys.length) for (const path of [c.oldPath,c.path]) {
        const stem = posix.parse(path).name;
        const module = stem === "index" ? posix.basename(posix.dirname(path)) : stem;
        if (!module) continue;
        for (const key of keys) addTo(modules,module,key);
      }
    } catch { uncertain.add(identity); }
  }

  const callers = new Map<string,Set<string>>();
  const anchors = new Map<string,Set<number>>();
  const aliases = new Map<string, Set<string>>();
  const terms = [...new Set([...symbols.keys(),...modules.keys()])];
  if (terms.length) {
    // Dynamic module selection cannot be assigned to a fixed declaration.
    const dynamic = repo.git(["grep","-l","-I","-E",String.raw`(import|require)[[:space:]]*\([[:space:]]*[a-zA-Z_$]`,repo.head,"--",...sourceGlobs],true);
    if (dynamic.trim()) for (const key of namesByIdentity.keys()) uncertain.add(key);
  }
  for (let offset=0; offset<terms.length; offset+=100) {
    const group = terms.slice(offset,offset+100);
    // Look up all changed names in a group with one Git process per tree.
    for (const rev of [repo.base,repo.head]) {
      try {
        const out = repo.git(["grep","-n","-I","-w","-z","-F",...group.flatMap(s=>["-e",s]),rev,"--",...sourceGlobs],true);
        for (const row of out.split("\n")) {
          const [file,line,text] = row.split("\0");
          if (text === undefined) continue;
          const path = file.slice(rev.length+1);
          if (isPrivatePath(path)) continue;
          const references = new Map<string, Set<string>>();
          for (const word of new Set(text.match(/[\w$]+/g))) {
            const ids = symbols.get(word);
            if (ids) references.set(word,ids);
          }
          const indirect = /\b(?:export\s*\*|import\s+(?!\{|type\s*\{)|(?:import|require)\s*\()/.test(text);
          if (indirect) for (const m of text.matchAll(/["']([^"']+)["']/g)) {
            const stem = posix.parse(m[1]).name;
            const ids = modules.get(stem);
            if (ids) references.set(m[1],ids);
          }
          for (const [word, ids] of references) {
            for (const key of ids) {
              if (namesByIdentity.get(key) === path) continue;
              addTo(callers,path,key);
              if (/\bexport\s*(?:\*|\{)/.test(text)) uncertain.add(key);
              if (rev !== repo.head) continue;
              addTo(anchors,path,Number(line));
              const match = /^\s+as\s+([\w$]+)/.exec(text.slice(text.indexOf(word)+word.length));
              if (match) addTo(aliases,path,match[1]);
            }
          }
        }
      } catch { for (const name of group) for (const key of [...(symbols.get(name) ?? []),...(modules.get(name) ?? [])]) uncertain.add(key); }
    }
  }
  const extra: Change[] = [];
  const changed = new Set(repo.files);
  for (const row of callers.size ? repo.git(["ls-tree","-rz",repo.head]).split("\0") : []) {
    const m = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!m || !callers.has(m[3])) continue;
    const [,mode,oid,path] = m;
    const bindings = aliases.get(path);
    if (bindings?.size) {
      const text = repo.git(["cat-file","blob",oid]);
      const lines = anchors.get(path)!;
      text.split("\n").forEach((line,i)=>{
        if (line.match(/[\w$]+/g)?.some(word=>bindings.has(word))) lines.add(i+1);
      });
    }
    if (!anchors.has(path) || changed.has(path)) continue;
    extra.push({path,oldPath:path,status:"caller",oldOid:"0".repeat(oid.length),newOid:oid,
      oldMode:"000000",newMode:mode,added:0,deleted:0});
  }
  const contracts = new Map([...callers].map(([path,ids])=>[path,[...ids].flatMap(id=>signatures.has(id) ? [signatures.get(id)!] : [])]));
  return {extra, anchors, contracts, uncertain:hash(uncertain), dependencies:new Map([...callers].map(([path,ids])=>[path,hash(ids)]))};
}
