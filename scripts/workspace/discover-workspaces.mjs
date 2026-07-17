import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const workspaceGroups = [
  { directory: "apps", kind: "app" },
  { directory: "packages", kind: "package", excludedNames: new Set(["adapters"]) },
  { directory: "packages/adapters", kind: "adapter" },
];

/**
 * 列出目录中的直接子目录并按名称排序。
 *
 * 目录不存在时返回空列表；其他读取错误继续向调用方抛出。
 *
 * 参数 `absoluteDirectory` 是要扫描的绝对目录；返回排序后的直接子目录名称。
 */
async function listDirectories(absoluteDirectory) {
  try {
    return (await readdir(absoluteDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * 发现仓库中受支持的应用、核心包和适配器工作区。
 *
 * `packages/adapters` 仅作为分组目录；工作区缺少 package.json 时保留条目并将 manifest 设为 null。
 *
 * 参数 `repositoryRoot` 是仓库根目录；返回按配置分组和目录名称稳定排序的工作区描述列表。
 */
export async function discoverWorkspaces(repositoryRoot) {
  const workspaces = [];

  for (const group of workspaceGroups) {
    const absoluteGroup = path.join(repositoryRoot, ...group.directory.split("/"));
    const names = await listDirectories(absoluteGroup);

    for (const name of names) {
      if (group.excludedNames?.has(name)) {
        continue;
      }

      const relativePath = `${group.directory}/${name}`;
      const manifestPath = path.join(repositoryRoot, ...relativePath.split("/"), "package.json");
      let manifest = null;

      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch (error) {
        if (!(error && typeof error === "object" && error.code === "ENOENT")) {
          throw error;
        }
      }

      workspaces.push({
        absolutePath: path.join(repositoryRoot, ...relativePath.split("/")),
        kind: group.kind,
        manifest,
        relativePath,
      });
    }
  }

  return workspaces;
}
