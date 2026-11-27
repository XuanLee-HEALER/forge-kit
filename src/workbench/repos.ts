import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { findWorkbenchRoot, repoCardPath } from "../config";
import { localPath } from "../instance";
import { checkMigration } from "../managed-assets";
import { withConfigWriteLock } from "./config-lock";

function detectRepoCommands(repoDir: string): {
  stack: string[];
  commands: string[];
  workflows: string[];
} {
  const stack: string[] = [];
  const commands: string[] = [];
  const workflows: string[] = [];

  if (existsSync(join(repoDir, "go.mod"))) {
    stack.push("Go");
    commands.push("`go test ./...`");
  }
  if (existsSync(join(repoDir, "pyproject.toml"))) {
    stack.push("Python");
    commands.push("`pytest tests/ -q`");
  }
  if (existsSync(join(repoDir, "package.json"))) {
    stack.push("JavaScript/TypeScript (Bun)");
    try {
      const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as {
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
  if (existsSync(join(repoDir, "justfile"))) {
    stack.push("just");
    commands.push("`just --list`");
  }
  if (existsSync(join(repoDir, "Makefile"))) {
    const mk = readFileSync(join(repoDir, "Makefile"), "utf8");
    const targets = ["build", "test", "lint", "generate", "api", "dal"].filter((t) =>
      new RegExp(`^${t}:`, "m").test(mk),
    );
    if (targets.length) {
      commands.push(...targets.map((t) => `\`make ${t}\``));
    }
  }
  const wfDir = join(repoDir, ".github", "workflows");
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir)) {
      if (f.endsWith(".yml") || f.endsWith(".yaml")) {
        workflows.push(`.github/workflows/${f}`);
      }
    }
  }
  return { stack, commands: [...new Set(commands)], workflows };
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
      `- **技术栈**：${info.stack.join(" / ") || "待补充"}`,
      `- **仓库路径**：\`${rel || repoName}\``,
      "",
      "## 本地命令",
      "",
      ...(info.commands.length ? info.commands.map((c) => `- ${c}`) : ["- 待补充构建、测试与生成命令"]),
      "",
      "## CI / 部署",
      "",
      ...(info.workflows.length ? info.workflows.map((w) => `- \`${w}\``) : ["- 暂无 `.github/workflows`"]),
      "",
      "## 仓库专属边界与约定",
      "",
      "- 遵循工作台 `AGENTS.md`；如本仓有更严格的分支、数据库或发布限制，补充于此。",
      "",
    ].join("\n");
    mkdirSync(dirname(cardPath), { recursive: true });
    writeFileSync(cardPath, md, "utf8");
  }

  const registered = updateReposInWorkbenchYaml(yamlPath, repoName);

  return { repoName, cardPath, registered };
}
