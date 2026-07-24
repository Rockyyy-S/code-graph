/** @file 复用 checked-in ESM runtime 的 RFC 8785 JCS 与 SHA-256 权威实现。 */
export {
  canonicalizeJson,
  sha256CanonicalJson,
  sha256Hex,
} from "../runtime/canonical-json.mjs";
