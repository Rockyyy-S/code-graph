import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  sha256CanonicalJson,
  sha256Hex,
} from "../../packages/contracts/src/canonical-json.js";

describe("canonical JSON", () => {
  it("按 UTF-16 键序生成稳定 JCS 并保持数组顺序", () => {
    expect(canonicalizeJson({ z: [3, 2, 1], a: "中文", nested: { b: 2, a: 1 } })).toBe(
      '{"a":"中文","nested":{"a":1,"b":2},"z":[3,2,1]}',
    );
    expect(canonicalizeJson(["b", "a"])).not.toBe(canonicalizeJson(["a", "b"]));
  });

  it("复现公开 SHA-256 固定向量", () => {
    expect(canonicalizeJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(sha256CanonicalJson({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    expect(sha256Hex(new TextEncoder().encode('{"a":1,"b":2}'))).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  it.each([
    ["undefined 字段", { value: undefined }],
    ["数组 undefined", [undefined]],
    ["非有限数", { value: Number.POSITIVE_INFINITY }],
    ["NaN", { value: Number.NaN }],
    ["BigInt", { value: 1n }],
    ["非法高代理项", { value: "\ud800" }],
    ["非法低代理项", { value: "\udc00" }],
    ["非 JSON 对象", new Date(0)],
  ])("拒绝 %s", (_label, value) => {
    expect(() => canonicalizeJson(value)).toThrow(/JCS/);
  });

  it("保留合法代理项对且将负零规范为零", () => {
    expect(canonicalizeJson({ emoji: "😀", negativeZero: -0 })).toBe(
      '{"emoji":"😀","negativeZero":0}',
    );
  });

  it("拒绝数组访问器、Symbol、不可枚举元素和自定义原型且不执行 getter", () => {
    let getterCalls = 0;
    const accessor = [1];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 1;
      },
    });
    const symbolField = [1];
    Object.defineProperty(symbolField, Symbol("hidden"), { value: 2 });
    const hiddenElement = [1];
    Object.defineProperty(hiddenElement, "0", { enumerable: false, value: 1 });
    const customPrototype = [1];
    Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));

    for (const value of [accessor, symbolField, hiddenElement, customPrototype]) {
      expect(() => canonicalizeJson(value)).toThrow(/JCS/u);
    }
    expect(getterCalls).toBe(0);
  });
});
