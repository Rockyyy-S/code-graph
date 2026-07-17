import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanBasicSecurity } from "../../scripts/security/check-basic-security.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("basic security coverage", () => {
  it("scans root env variants, TSX, and quoted or composite credential fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-security-coverage-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "apps", "sample"), { recursive: true });
    await writeFile(path.join(root, ".env.local"), 'DATABASE_PASSWORD="changeme"\n', "utf8");
    await writeFile(
      path.join(root, "apps", "sample", "view.tsx"),
      'const jwtSecret = "dummy-secret";\nexport { jwtSecret };\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "apps", "sample", "config.json"),
      '{"client_secret":"replace-me"}\n',
      "utf8",
    );

    const findings = await scanBasicSecurity(root);

    expect(findings.map(({ relativePath }) => relativePath).sort()).toEqual([
      ".env.local",
      "apps/sample/config.json",
      "apps/sample/view.tsx",
    ]);
  });
});
