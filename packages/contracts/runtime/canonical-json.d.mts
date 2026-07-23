/** 按 RFC 8785 JCS 规范序列化纯 JSON 值。 */
export declare function canonicalizeJson(value: unknown): string;

/** 对 UTF-8 文本或原始字节计算小写十六进制 SHA-256。 */
export declare function sha256Hex(value: string | Uint8Array): string;

/** 对纯 JSON 值执行 JCS、UTF-8 与 SHA-256。 */
export declare function sha256CanonicalJson(value: unknown): string;
