import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { inspectApplyPath } from "../apply/catalog";
import { readApplyManifest } from "../apply/facts";
import { findWorkbenchRoot, repoCardPath } from "../config";
import { localPath } from "../instance";
import { checkMigration } from "../managed-assets";
import { withConfigWriteLock } from "./config-lock";

function detectRepoCommands(repoDir: string): {
  stack: string[];
  commands: string[];
  workflowCount: number | undefined;
} {
  const exists = (path: string) => {
    try { return inspectApplyPath(repoDir, path).stat?.isFile() ?? false; }
    catch { return false; }
  };
  const stack: string[] = [];
  const commands: string[] = [];
  let workflowCount: number | undefined = 0;

  if (exists("go.mod")) {
    stack.push("Go");
    commands.push("`go test ./...`");
  }
  if (exists("pyproject.toml")) {
    stack.push("Python");
    commands.push("`pytest tests/ -q`");
  }
  if (exists("package.json")) {
    stack.push("JavaScript/TypeScript (Bun)");
    try {
      const pkg = JSON.parse(readApplyManifest({ dir: repoDir, boundaries: [] }, "package.json")) as {
        scripts?: Record<string, string>;
      };
      const runner = "bun run";
      for (const key of ["check", "lint", "typecheck", "test", "build"]) {
        if (pkg.scripts?.[key]) commands.push(`\`${runner} ${key}\``);
      }
    } catch {
      // Ignore invalid package.json
    }
  }
  if (exists("justfile")) {
    stack.push("just");
    commands.push("`just --list`");
  }
  const makefile = ["GNUmakefile", "makefile", "Makefile"].find(exists);
  if (makefile) {
    try {
      const mk = readApplyManifest({ dir: repoDir, boundaries: [] }, makefile);
      const targets = ["build", "test", "lint", "generate", "api", "dal"].filter((target) =>
        new RegExp(`^${target}:`, "m").test(mk),
      );
      commands.push(...targets.map((target) => "\`make " + target + "\`"));
    } catch { /* An unreadable makefile supplies no verified commands. */ }
  }
  const workflowPath = ".github/workflows";
  try {
    const safe = inspectApplyPath(repoDir, workflowPath);
    if (safe.path === join(repoDir, workflowPath) && safe.stat?.isDirectory()) {
      workflowCount = readdirSync(safe.path, { withFileTypes: true })
        .filter(entry => entry.isFile() && /\.ya?ml$/i.test(entry.name)).length;
    }
  } catch { workflowCount = undefined; }
  return { stack, commands: [...new Set(commands)], workflowCount };
}

function updateReposInWorkbenchYaml(yamlPath: string, repoName: string): boolean {
  return withConfigWriteLock(yamlPath, () => {
    const raw = readFileSync(yamlPath, "utf8");
    const parsed = (Bun.YAML.parse(raw) ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(parsed.repos) ? parsed.repos.map(String) : [];
    if (existing.includes(repoName)) return false;

    const updatedRepos = [...existing, repoName];
    const block = `repos:\n${updatedRepos.map((r) => `  - ${JSON.stringify(r)}`).join("\n")}\n`;

    let next: string;
    if (/^repos:\s*\[[^\]]*\]\s*$/m.test(raw)) {
      next = raw.replace(/^repos:\s*\[[^\]]*\]\s*$/m, block.trimEnd());
    } else if (/^repos:\s*\n(?:[ \t]*-\s+.*\n)*/m.test(raw)) {
      next = raw.replace(/^repos:\s*\n(?:[ \t]*-\s+.*\n)*/m, block);
    } else if (/^repos:\s*$/m.test(raw)) {
      next = raw.replace(/^repos:\s*$/m, block.trimEnd());
    } else {
      next = `${raw.trimEnd()}\n\n${block}`;
    }

    const tmp = `${yamlPath}.${process.pid}.tmp`;
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, yamlPath);

    const verify = (Bun.YAML.parse(readFileSync(yamlPath, "utf8")) ?? {}) as Record<string, unknown>;
    const verifiedList = Array.isArray(verify.repos) ? verify.repos.map(String) : [];
    if (!verifiedList.includes(repoName)) {
      throw new Error(`Failed to persist repo "${repoName}" into ${yamlPath}`);
    }
    return true;
  });
}

export function addRepo(opts: { repoPath: string; workbenchDir?: string; force?: boolean }): {
  repoName: string;
  cardPath: string;
  registered: boolean;
} {
  const absRepo = realpathSync(opts.repoPath);
  const gitEntry = join(absRepo, ".git");
  if (!existsSync(gitEntry)) {
    throw new Error(`Not a git repository: ${absRepo}`);
  }
  if (!statSync(gitEntry).isDirectory()) {
    throw new Error(
      `${absRepo} is a linked git worktree (.git is a file, not a directory). Register the primary repository instead.`,
    );
  }
  const root = findWorkbenchRoot(opts.workbenchDir ?? absRepo, true);
  checkMigration(root);
  const yamlPath = localPath(root, ".workbench/workbench.yaml");
  for (const file of [yamlPath, localPath(root, ".workbench/kit-lock.json")])
    if (!statSync(file, {throwIfNoEntry: false})?.isFile())
      throw Error("Not an initialized workbench: missing " + file + "; use forge init");
  const rel = relative(root, absRepo);
  if (rel.startsWith("..") || rel.includes("/")) {
    throw new Error(
      `Repository ${absRepo} must be the workbench root or a direct subdirectory inside workbench root ${root} so guard/ledger/wb-git can track it consistently.`,
    );
  }

  const repoName = rel || ".";
  const cardPath = repoCardPath(root, repoName);

  if (!existsSync(cardPath) || opts.force) {
    const info = detectRepoCommands(absRepo);
    const md = [
      `# ${repoName}`,
      "",
      "## 技术栈与本地命令",
      "",
      `- **技术栈**：${info.stack.join(" / ") || "待核实"}`,
      `- **仓库路径**：\`${rel || repoName}\`\``,
      ...(info.commands.length ? info.commands.map((c) => `- ${c}`) : ["- 待补充构建、测试与生成命令"]),
      "",
      "## 代码风格与偏好",
      "",
      "- 结合近期样板路径记录分层命名、数据访问、错误处理与最小测试闭环。",
      "",
      "## CI 与分支约束",
      "",
      info.workflowCount === undefined ? "- GitHub Actions 清单待核实。" :
        `- GitHub Actions 有效 workflow 共 ${info.workflowCount} 个。运行 \`forge apply --json\` 查看路径。`,
      "- 待核实长期分支、发布标签及必需检查。",
      "",
      "## 禁区与历史旧范式",
      "",
      "- 记录经确认的敏感路径、勿照抄的旧写法及其替代样板。",
      "",
      "## Domain Index",
      "",
    ].join("\n");
    mkdirSync(dirname(cardPath), { recursive: true });
    writeFileSync(cardPath, md, "utf8");
  }

  const registered = updateReposInWorkbenchYaml(yamlPath, repoName);

  return { repoName, cardPath, registered };
}
