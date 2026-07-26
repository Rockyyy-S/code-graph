import { readdir } from "node:fs/promises";
import { normalizeRelativeGraphPath } from "@codegraph/application";
import { sha256CanonicalJson } from "@codegraph/contracts";

/** Story 1.4 固定且不可重排的内置排除规则。 */
export const BUILTIN_IGNORE_V1 = Object.freeze([
  "/.git/",
  "**/node_modules/",
  "**/.pnpm/",
  "**/dist/",
  "**/build/",
  "**/out/",
  "**/coverage/",
  "**/.next/",
  "**/.nuxt/",
  "**/.svelte-kit/",
  "**/.turbo/",
  "**/.cache/",
  "**/generated/",
  "**/.generated/",
  "**/__generated__/",
] as const);

/** scanner 与未来 Analyzer 唯一允许消费的有效排除快照。 */
export interface EffectiveIgnoreSnapshotV1 {
  builtinRulesVersion: "builtin-ignore-v1";
  contentHash: null;
  effectiveDigest: string;
  effectiveRules: typeof BUILTIN_IGNORE_V1;
  generation: 0;
  lastValidDigest: string;
  userRules: readonly [];
  validity: "valid";
  version: 1;
}

/** 首次配置屏障结果；存在用户配置时不构造伪造 generation 0。 */
export type InitialIgnoreState =
  | { kind: "ready"; snapshot: EffectiveIgnoreSnapshotV1 }
  | { kind: "unsupported-user-config" };

/**
 * 在服务开放 Job 前建立首次 ignore 状态。
 *
 * `.codegraphignore` 只要作为任意同名对象存在，就保留控制面但阻断 rebuild。
 */
export async function createInitialIgnoreState(indexingRoot: string): Promise<InitialIgnoreState> {
  try {
    const hasReservedIgnoreName = (await readdir(indexingRoot)).some((name) =>
      name.normalize("NFC").toLowerCase() === ".codegraphignore");
    if (hasReservedIgnoreName) {
      return Object.freeze({ kind: "unsupported-user-config" });
    }
  } catch {
    /** 无法完整枚举根目录时不能证明保留名不存在，启动屏障按用户配置存在处理。 */
    return Object.freeze({ kind: "unsupported-user-config" });
  }

  const digestInput = {
    builtinRulesVersion: "builtin-ignore-v1" as const,
    effectiveRules: BUILTIN_IGNORE_V1,
    version: 1 as const,
  };
  const effectiveDigest = sha256CanonicalJson(digestInput);
  return Object.freeze({
    kind: "ready",
    snapshot: Object.freeze({
      ...digestInput,
      contentHash: null,
      effectiveDigest,
      generation: 0,
      lastValidDigest: effectiveDigest,
      userRules: [] as const,
      validity: "valid",
    }),
  });
}

/** 使用固定类别匹配器判断规范相对路径是否被 BuiltinIgnoreV1 排除。 */
export function isBuiltinIgnoredPath(
  relativePath: string,
  snapshot: EffectiveIgnoreSnapshotV1,
): boolean {
  if (
    snapshot.builtinRulesVersion !== "builtin-ignore-v1" ||
    snapshot.effectiveRules.length !== BUILTIN_IGNORE_V1.length ||
    !snapshot.effectiveRules.every((rule, index) => rule === BUILTIN_IGNORE_V1[index])
  ) {
    throw new TypeError("scanner 收到了不受支持的排除快照。");
  }
  const normalized = normalizeRelativeGraphPath(relativePath);
  const segments = normalized.split("/");
  if (segments[0] === ".git") {
    return true;
  }
  const ignoredDirectoryNames = new Set([
    "node_modules",
    ".pnpm",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    "generated",
    ".generated",
    "__generated__",
  ]);
  return segments.some((segment) => ignoredDirectoryNames.has(segment));
}
