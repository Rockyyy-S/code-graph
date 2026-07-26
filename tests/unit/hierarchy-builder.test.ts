import { describe, expect, it } from "vitest";
import {
  buildHierarchyGraph,
  isSupportedSourceFile,
} from "../../packages/application/src/index.js";

describe("hierarchy builder", () => {
  it("locks the current TS/JS classifier to the planned suffix set", () => {
    for (const file of [
      "a.ts",
      "a.tsx",
      "a.mts",
      "a.cts",
      "a.js",
      "a.jsx",
      "a.mjs",
      "a.cjs",
    ]) {
      expect(isSupportedSourceFile(file)).toBe(true);
    }
    for (const file of ["a.json", "a.css", "a.py", "a.ts.map", "README"] ) {
      expect(isSupportedSourceFile(file)).toBe(false);
    }
  });

  it("creates only workspace, included ancestors, files, and container-to-child edges", () => {
    const graph = buildHierarchyGraph("b".repeat(64), [
      "src/index.ts",
      "src/nested/view.tsx",
    ]);

    expect(graph.nodes.map((node) => [node.kind, node.relativePath])).toEqual([
      ["workspace", ""],
      ["directory", "src"],
      ["directory", "src/nested"],
      ["file", "src/index.ts"],
      ["file", "src/nested/view.tsx"],
    ]);
    expect(graph.edges).toHaveLength(4);
    expect(graph.edges.every((edge) => edge.relationType === "contains")).toBe(true);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
    expect(new Set(graph.edges.map((edge) => edge.id)).size).toBe(graph.edges.length);
  });
});
