import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findForbiddenTestMarkers } from "../../scripts/quality/check-test-markers.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("test marker policy", () => {
  it("detects conditional and chained skip/focus APIs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-test-markers-"));
    temporaryRoots.push(root);
    const testRoot = path.join(root, "tests", "unit");
    await mkdir(testRoot, { recursive: true });
    await writeFile(
      path.join(testRoot, "bypass.test.ts"),
      [
        'test.skipIf(true)("skipped", () => {});',
        'test.runIf(false)("not run", () => {});',
        'test.skip.each([1])("skipped row", () => {});',
        'describe.concurrent.only("focused", () => {});',
      ].join("\n"),
      "utf8",
    );

    const findings = await findForbiddenTestMarkers(root);

    expect(findings.map(({ label }) => label)).toEqual([
      "conditional test",
      "conditional test",
      "skipped test",
      "focused test",
    ]);
  });
});
