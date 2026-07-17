import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { discoverWorkspaces } from "../workspace/discover-workspaces.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

/**
 * 返回工作区在指定根命令下必须使用的精确执行命令。
 *
 * extension 工作区使用自身的 TypeScript 与 esbuild 配置，其他工作区使用统一构建配置。
 *
 * 参数 `workspace` 是待检查的工作区，`scriptName` 是根级质量命令名称；返回工作区清单中应声明的命令。
 */
function expectedWorkspaceCommand(workspace, scriptName) {
  if (scriptName === "type") {
    return workspace.relativePath === "apps/extension"
      ? "tsc -b tsconfig.json --pretty false"
      : "tsc -b tsconfig.build.json --pretty false";
  }
  return workspace.relativePath === "apps/extension"
    ? "node esbuild.mjs --production"
    : "tsc -p tsconfig.build.json";
}

/**
 * 收集参与工作区拓扑排序的内部依赖名称。
 *
 * 仅检查标准依赖字段，并返回去重且按名称排序的内部工作区依赖。
 *
 * 参数 `manifest` 是工作区的 package.json 内容，`workspacesByName` 是按包名索引的工作区映射；返回已声明的内部工作区依赖名称。
 */
function internalDependencyNames(manifest, workspacesByName) {
  const names = new Set();
  for (const field of dependencyFields) {
    for (const name of Object.keys(manifest?.[field] ?? {})) {
      if (workspacesByName.has(name)) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

/**
 * 按内部依赖优先顺序排列工作区，并报告依赖环。
 *
 * 排序采用确定性的深度优先遍历；发现循环时保留诊断，但不抛出异常。
 *
 * 参数 `workspaces` 是待排序的工作区集合；返回错误列表与排序后的工作区。
 */
export function orderWorkspacesByDependencies(workspaces) {
  const errors = [];
  const ordered = [];
  const stateByName = new Map();
  const workspacesByName = new Map(
    workspaces
      .filter(({ manifest }) => typeof manifest?.name === "string")
      .map((workspace) => [workspace.manifest.name, workspace]),
  );

  /**
   * 递归访问单个工作区并维护拓扑遍历状态。
   *
   * 参数 `workspace` 是当前访问的工作区，`trail` 是当前递归链中的包名；此函数不返回结果。
   */
  function visit(workspace, trail) {
    const name = workspace.manifest?.name ?? workspace.relativePath;
    const state = stateByName.get(name);
    if (state === "visited") {
      return;
    }
    if (state === "visiting") {
      errors.push(
        `${workspace.relativePath}/package.json: workspace dependency cycle detected (${[...trail, name].join(" -> ")}). Fix: restore an inward-only dependency direction.`,
      );
      return;
    }

    stateByName.set(name, "visiting");
    for (const dependencyName of internalDependencyNames(
      workspace.manifest,
      workspacesByName,
    )) {
      visit(workspacesByName.get(dependencyName), [...trail, name]);
    }
    stateByName.set(name, "visited");
    ordered.push(workspace);
  }

  for (const workspace of [...workspaces].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    visit(workspace, []);
  }

  return { errors: [...new Set(errors)], workspaces: ordered };
}

/**
 * 判断文件或目录是否存在。
 *
 * 参数 `absolutePath` 是待检查的绝对路径；路径可访问时返回 true，否则返回 false。
 */
async function fileExists(absolutePath) {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 校验所有工作区是否声明并具备指定的真实质量命令。
 *
 * 参数 `root` 是仓库根目录，`scriptName` 是要校验的根级质量命令名称；返回错误列表与依赖优先排序后的工作区。
 */
export async function validateWorkspaceScripts(root, scriptName) {
  const errors = [];
  const workspaces = await discoverWorkspaces(root);

  if (workspaces.length === 0) {
    errors.push(
      "pnpm-workspace.yaml: no product workspaces were discovered. Fix: add an app, package, or adapter with package.json.",
    );
  }

  for (const workspace of workspaces) {
    const manifestPath = `${workspace.relativePath}/package.json`;
    if (workspace.manifest === null) {
      errors.push(
        `${manifestPath}: workspace manifest is missing. Fix: add package.json with explicit type and build scripts.`,
      );
      continue;
    }

    const expectedCommand = expectedWorkspaceCommand(workspace, scriptName);
    if (workspace.manifest.scripts?.[scriptName] !== expectedCommand) {
      errors.push(
        `${manifestPath}: '${scriptName}' must be a real TypeScript ${scriptName} command. Fix: restore '${expectedCommand}'.`,
      );
    }

    if (
      scriptName === "type" &&
      !(await fileExists(path.join(workspace.absolutePath, "tsconfig.json")))
    ) {
      errors.push(
        `${workspace.relativePath}/tsconfig.json: required type configuration is missing. Fix: add an explicit workspace TypeScript config.`,
      );
    }
  }

  const ordered = orderWorkspacesByDependencies(workspaces);
  errors.push(...ordered.errors);
  return { errors, workspaces: ordered.workspaces };
}

/**
 * 按依赖顺序在所有工作区执行指定质量命令。
 *
 * 校验失败或任一子进程失败时立即返回非零退出码，并将子进程输出直接转发到当前终端。
 *
 * 参数 `root` 是仓库根目录，`scriptName` 是要执行的根级质量命令名称；成功时返回 0，否则返回对应失败退出码。
 */
export async function runWorkspaceScript(root, scriptName) {
  const { errors, workspaces } = await validateWorkspaceScripts(root, scriptName);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    return 1;
  }

  const packageManagerCli = process.env.npm_execpath;
  if (!packageManagerCli) {
    console.error(
      `package.json: '${scriptName}' must be invoked through pnpm. Fix: run 'pnpm ${scriptName}'.`,
    );
    return 1;
  }

  for (const workspace of workspaces) {
    const result = spawnSync(
      process.execPath,
      [packageManagerCli, "--dir", workspace.absolutePath, "run", scriptName],
      { env: process.env, stdio: "inherit" },
    );

    if (result.status !== 0) {
      console.error(
        `${workspace.relativePath}/package.json: '${scriptName}' failed. Fix: resolve the reported workspace error before retrying.`,
      );
      return result.status ?? 1;
    }
  }

  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scriptName = process.argv[2];
  if (scriptName !== "type" && scriptName !== "build") {
    console.error(
      "package.json: workspace runner requires 'type' or 'build'. Fix: use a declared root quality command.",
    );
    process.exitCode = 1;
  } else {
    process.exitCode = await runWorkspaceScript(repositoryRoot, scriptName);
  }
}
