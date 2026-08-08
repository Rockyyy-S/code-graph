import {
  decodeModuleExportName,
  encodeModuleExportName,
} from "./module-dependency.js";

/** hierarchy 切片允许使用工作区相对路径构造的实体类型。 */
export type HierarchyEntityKind = "directory" | "file" | "workspace";

/** 当前持久图谱允许的封闭实体类型。 */
export type GraphEntityKind = HierarchyEntityKind | "external-package" | "node-builtin";

/** 当前持久图谱允许的封闭关系类型。 */
export type GraphRelationType = "contains" | "exports" | "imports";

/** AD-4 v1 关系身份协议的稳定标识与版本。 */
export const GRAPH_EDGE_ID_PROTOCOL_ID = "graph-edge-id-ad4-v1";
export const GRAPH_EDGE_ID_VERSION = 1;

/**
 * 将输入路径规范为工作区相对、Unicode NFC、POSIX 分隔格式。
 *
 * 绝对路径、父目录逃逸、NUL 与空路径段均在进入公共身份前拒绝。
 */
export function normalizeRelativeGraphPath(input: string): string {
  if (
    typeof input !== "string" ||
    input.includes("\0") ||
    input.startsWith("/") ||
    input.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(input)
  ) {
    throw new TypeError("图谱路径必须是安全的工作区相对路径。");
  }
  if (input.length === 0) {
    return "";
  }
  const segments: string[] = [];
  for (const rawSegment of input.replaceAll("\\", "/").split("/")) {
    const segment = rawSegment.normalize("NFC");
    if (segment === ".") {
      continue;
    }
    if (segment.length === 0 || segment === "..") {
      throw new TypeError("图谱路径包含空段或父目录逃逸。");
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/** 使用工作区作用域、实体类型和规范相对路径构造确定性 cg:// ID。 */
export function buildGraphEntityId(
  workspaceKey: string,
  kind: HierarchyEntityKind,
  relativePath: string,
): string {
  assertWorkspaceKey(workspaceKey);
  const normalizedPath = normalizeRelativeGraphPath(relativePath);
  if (kind === "workspace") {
    if (normalizedPath.length !== 0) {
      throw new TypeError("workspace 实体不能携带相对路径。");
    }
    return `cg://${workspaceKey}/workspace/`;
  }
  if (normalizedPath.length === 0) {
    throw new TypeError(`${kind} 实体必须携带非空相对路径。`);
  }
  const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
  return `cg://${workspaceKey}/${kind}/${encodedPath}${kind === "directory" ? "/" : ""}`;
}

/**
 * 按 AD-4 v1 对规范七元组执行 JCS/UTF-8/SHA-256，构造唯一关系 ID。
 *
 * 这里拒绝而不是修复非 NFC 或不成对代理项，避免不同调用方在身份边界静默收敛。
 */
export function buildGraphEdgeId(
  workspaceKey: string,
  fromId: string,
  relationType: GraphRelationType,
  toId: string,
  qualifier = "",
): string {
  assertWorkspaceKey(workspaceKey);
  assertCanonicalEdgeTuple(fromId, relationType, toId, qualifier);
  const preimage = JSON.stringify([
    "codegraph.graph-edge-id",
    GRAPH_EDGE_ID_VERSION,
    workspaceKey,
    relationType,
    fromId,
    toId,
    qualifier,
  ]);
  return `cg://${workspaceKey}/edge/v1/${sha256Utf8Hex(preimage)}`;
}

/**
 * 仅供 SQLite v1-v3 migration 与历史证据严格复核使用的旧身份编码器。
 *
 * 新写入、公开输出和常规读取绝不能调用此函数。
 */
export function buildLegacyGraphEdgeIdV0(
  workspaceKey: string,
  fromId: string,
  relationType: GraphRelationType,
  toId: string,
  qualifier = "",
): string {
  assertWorkspaceKey(workspaceKey);
  const identity = [fromId, relationType, toId, qualifier].join("\0").normalize("NFC");
  return `cg://${workspaceKey}/edge/${encodeURIComponent(identity)}`;
}

/** 工作区公共身份只接受完整 SHA-256 小写十六进制。 */
function assertWorkspaceKey(workspaceKey: string): void {
  if (!/^[a-f0-9]{64}$/u.test(workspaceKey)) {
    throw new TypeError("workspaceKey 必须是 SHA-256 小写十六进制。");
  }
}

/** AD-4 只接受封闭关系词汇、规范 qualifier 与已经规范化的字符串。 */
function assertCanonicalEdgeTuple(
  fromId: string,
  relationType: GraphRelationType,
  toId: string,
  qualifier: string,
): void {
  if (relationType !== "contains" && relationType !== "imports" && relationType !== "exports") {
    throw new TypeError("关系类型不属于 AD-4 v1 封闭词汇。");
  }
  [
    [fromId, "fromId"],
    [relationType, "relationType"],
    [toId, "toId"],
    [qualifier, "qualifier"],
  ].forEach(([value, label]) => assertCanonicalUnicode(value!, label!));
  const qualifierValid = relationType === "contains"
    ? qualifier === ""
    : relationType === "imports"
      ? qualifier === "value" || qualifier === "type" || qualifier === "dynamic"
      : qualifier === "star:value" || qualifier === "star:type" ||
        isCanonicalReexportQualifier(qualifier);
  if (!qualifierValid) {
    throw new TypeError("关系 qualifier 不符合 AD-4 v1 规范词汇。");
  }
}

/** re-export 名称段只接受严格解码后可逐字节重编码的唯一外部表示。 */
function isCanonicalReexportQualifier(qualifier: string): boolean {
  const segments = qualifier.split(":");
  if (
    segments.length !== 4 ||
    segments[0] !== "reexport" ||
    (segments[3] !== "value" && segments[3] !== "type")
  ) {
    return false;
  }
  for (const [encoded, label] of [
    [segments[1]!, "reexport exported 名称"],
    [segments[2]!, "reexport imported 名称"],
  ] as const) {
    const decoded = decodeModuleExportName(encoded);
    assertCanonicalUnicode(decoded, label);
    if (encodeModuleExportName(decoded) !== encoded) {
      throw new TypeError(`${label} 的 percent-encoding 不是唯一规范形式。`);
    }
  }
  return true;
}

/** JCS 字符串域拒绝 lone surrogate，并要求调用方提供 byte-for-byte NFC 输入。 */
function assertCanonicalUnicode(value: string, label: string): void {
  if (typeof value !== "string" || value.normalize("NFC") !== value) {
    throw new TypeError(`${label} 必须已经是 Unicode NFC。`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} 包含不成对的 UTF-16 高代理项。`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${label} 包含不成对的 UTF-16 低代理项。`);
    }
  }
}

/** 无 Node 运行时依赖的同步 SHA-256，确保 domain 可在所有现有组合根中复用。 */
function sha256Utf8Hex(value: string): string {
  const bytes = encodeUtf8(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = schedule[index - 15]!;
      const previous2 = schedule[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^
        (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^
        (previous2 >>> 10);
      schedule[index] = (schedule[index - 16]! + sigma0 + schedule[index - 7]! + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temporary1 = (h! + bigSigma1 + choice + SHA256_ROUND_CONSTANTS[index]! +
        schedule[index]!) >>> 0;
      const bigSigma0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

/** 将已通过 Unicode 合法性检查的 JS 字符串编码为 UTF-8。 */
function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index)!;
    if (codePoint > 0xffff) {index += 1;}
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/** SHA-256 32 位循环右移。 */
function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

const SHA256_ROUND_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
