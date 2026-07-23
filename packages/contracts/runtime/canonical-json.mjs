import { createHash } from "node:crypto";

/**
 * 按 RFC 8785 JSON Canonicalization Scheme 序列化 JSON 值。
 *
 * 输入必须已经是纯 JSON 数据；函数会拒绝 undefined、BigInt、非有限数、稀疏数组、
 * 自定义原型、访问器、循环引用和不成对的 UTF-16 代理项，避免运行时对象语义进入摘要。
 *
 * @param {unknown} value 待规范化的纯 JSON 值。
 * @returns {string} UTF-16 键序稳定的 canonical JSON 文本。
 */
export function canonicalizeJson(value) {
  return serializeJsonValue(value, new Set());
}

/**
 * 对 UTF-8 文本或原始字节计算小写十六进制 SHA-256。
 *
 * @param {string | Uint8Array} value 待摘要的 UTF-8 文本或字节。
 * @returns {string} 64 位小写十六进制摘要。
 */
export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * 对纯 JSON 值执行 JCS、UTF-8 与 SHA-256。
 *
 * @param {unknown} value 待摘要的纯 JSON 值。
 * @returns {string} 64 位小写十六进制摘要。
 */
export function sha256CanonicalJson(value) {
  return sha256Hex(canonicalizeJson(value));
}

/** @param {unknown} value @param {Set<object>} ancestors @returns {string} */
function serializeJsonValue(value, ancestors) {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JCS 不接受非有限数字。");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return serializeArray(value, ancestors);
  }
  if (typeof value === "object") {
    return serializeObject(value, ancestors);
  }
  throw new TypeError("JCS 输入必须是纯 JSON 值。");
}

/** @param {unknown[]} value @param {Set<object>} ancestors @returns {string} */
function serializeArray(value, ancestors) {
  enterContainer(value, ancestors);
  try {
    const enumerableKeys = Object.keys(value);
    if (
      enumerableKeys.length !== value.length ||
      enumerableKeys.some((key, index) => key !== String(index))
    ) {
      throw new TypeError("JCS 不接受稀疏数组或数组附加字段。");
    }
    return `[${value.map((item) => serializeJsonValue(item, ancestors)).join(",")}]`;
  } finally {
    ancestors.delete(value);
  }
}

/** @param {object} value @param {Set<object>} ancestors @returns {string} */
function serializeObject(value, ancestors) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("JCS 不接受带自定义原型的非 JSON 对象。");
  }
  enterContainer(value, ancestors);
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw new TypeError("JCS 不接受 Symbol 字段。");
    }
    const keys = /** @type {string[]} */ (ownKeys).sort();
    const entries = keys.map((key) => {
      assertWellFormedUnicode(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new TypeError("JCS 不接受访问器或不可枚举字段。");
      }
      return `${JSON.stringify(key)}:${serializeJsonValue(descriptor.value, ancestors)}`;
    });
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** @param {object} value @param {Set<object>} ancestors */
function enterContainer(value, ancestors) {
  if (ancestors.has(value)) {
    throw new TypeError("JCS 不接受循环引用。");
  }
  ancestors.add(value);
}

/** @param {string} value */
function assertWellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("JCS 不接受不成对的 UTF-16 高代理项。");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("JCS 不接受不成对的 UTF-16 低代理项。");
    }
  }
}
