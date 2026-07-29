import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { observeHostPathIdentity } from "../../apps/graph-service/src/host-path-identity.js";

const temporaryRoots: string[] = [];

/** 仅删除本测试通过 mkdtemp 创建的已登记目录。 */
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

/** 创建当前实际 Windows 临时卷上的隔离合同目录。 */
async function createWindowsRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-host-path-identity-"));
  temporaryRoots.push(root);
  return root;
}

/** 仅把卷拒绝同名共存记录为能力限制，其他错误仍使合同失败。 */
function isCoexistenceUnsupported(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

describe("Windows host path identity contract", () => {
  beforeAll(() => {
    expect(process.platform, "该 blocking contract 必须在真实 Windows runner 上执行。").toBe("win32");
  });

  it("resolves ASCII casing aliases to one identity on the real temporary volume", async () => {
    const root = await createWindowsRoot();
    const canonicalPath = path.join(root, "AliasFile.ts");
    const aliasPath = path.join(root, "aLIASfILE.TS");
    await writeFile(canonicalPath, "export const value = 1;\n", { flag: "wx" });

    const canonical = await observeHostPathIdentity(canonicalPath);
    const alias = await observeHostPathIdentity(aliasPath);
    expect(canonical.status).toBe("present");
    expect(alias.status).toBe("present");
    if (canonical.status !== "present" || alias.status !== "present") {
      throw new Error("当前 Windows 临时卷不支持 ASCII casing alias 合同。");
    }
    expect(alias.identity).toBe(canonical.identity);
    expect(alias.canonicalPath).toBe(canonical.canonicalPath);
  });

  it("never merges distinct Unicode files merely because JavaScript lowercase collides", async () => {
    const root = await createWindowsRoot();
    const pairs = [
      ["ẞ.ts", "ß.ts"],
      ["İ.ts", "i̇.ts"],
    ] as const;

    for (const [leftName, rightName] of pairs) {
      const pairRoot = path.join(root, Buffer.from(leftName).toString("hex"));
      await mkdir(pairRoot);
      const leftPath = path.join(pairRoot, leftName);
      const rightPath = path.join(pairRoot, rightName);
      await writeFile(leftPath, "export const left = 1;\n", { flag: "wx" });
      try {
        await writeFile(rightPath, "export const right = 1;\n", { flag: "wx" });
      } catch (error) {
        if (!isCoexistenceUnsupported(error)) {
          throw error;
        }
        console.info(`[host-path-identity capability] 当前卷不允许 ${leftName}/${rightName} 共存。`);
        continue;
      }

      expect(leftName.toLowerCase()).toBe(rightName.toLowerCase());
      const left = await observeHostPathIdentity(leftPath);
      const right = await observeHostPathIdentity(rightPath);
      expect(left.status).toBe("present");
      expect(right.status).toBe("present");
      if (left.status !== "present" || right.status !== "present") {
        throw new Error("已共存文件必须能获得宿主身份证明。");
      }
      expect(left.identity).not.toBe(right.identity);
    }
  });

  it("reports delete and rename sequences without guessing a replacement identity", async () => {
    const root = await createWindowsRoot();
    const beforePath = path.join(root, "before.ts");
    const afterPath = path.join(root, "after.ts");
    await writeFile(beforePath, "export const value = 1;\n", { flag: "wx" });
    const before = await observeHostPathIdentity(beforePath);
    expect(before.status).toBe("present");
    if (before.status !== "present") {
      throw new Error("测试前置条件不成立。");
    }

    await rename(beforePath, afterPath);
    const missing = await observeHostPathIdentity(beforePath);
    const renamed = await observeHostPathIdentity(afterPath);
    expect(missing.status).toBe("missing");
    expect(renamed.status).toBe("present");
    if (renamed.status !== "present") {
      throw new Error("rename 后文件必须能获得宿主身份证明。");
    }
    expect(renamed.identity).toBe(before.identity);
    expect(renamed.evidenceDigest).not.toBe(before.evidenceDigest);

    await writeFile(beforePath, "export const replacement = 2;\n", { flag: "wx" });
    const replacement = await observeHostPathIdentity(beforePath);
    expect(replacement.status).toBe("present");
    if (replacement.status !== "present") {
      throw new Error("替换文件必须能获得宿主身份证明。");
    }
    expect(replacement.identity).not.toBe(before.identity);
  });
});
