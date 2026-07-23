import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDependencyBoundaries,
  formatBoundaryViolation,
} from "../../scripts/architecture/check-dependency-boundaries.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-boundary-fixture-"));
  temporaryRoots.push(root);
  return root;
}

async function addWorkspace(
  root: string,
  relativePath: string,
  name: string,
  role: string,
  dependencies: Record<string, string> = {},
  source = "export {};\n",
): Promise<void> {
  const workspaceRoot = path.join(root, ...relativePath.split("/"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify({
      codegraph: { role },
      dependencies,
      name,
      private: true,
      type: "module",
    }),
    "utf8",
  );
  await writeFile(path.join(workspaceRoot, "src/index.ts"), source, "utf8");
}

async function expectRule(root: string, rule: string): Promise<void> {
  const violations = await checkDependencyBoundaries(root);
  const matching = violations.filter((violation) => violation.rule === rule);

  expect(matching.length).toBeGreaterThan(0);
  for (const violation of matching) {
    const formatted = formatBoundaryViolation(violation);
    expect(violation.relativePath).not.toMatch(/^[A-Za-z]:/);
    expect(violation.suggestion.length).toBeGreaterThan(10);
    expect(formatted).toContain("Fix:");
    expect(formatted).not.toContain(root);
  }
}

describe("dependency boundary negative paths", () => {
  it("allows only the architecture-approved Story 1.2 external dependencies", async () => {
    const root = await createRepository();
    await addWorkspace(
      root,
      "packages/contracts",
      "@codegraph/contracts",
      "contracts",
      { ajv: "8.20.0" },
      'import "ajv";\n',
    );
    await addWorkspace(
      root,
      "packages/service-client",
      "@codegraph/service-client",
      "service-client",
      { "vscode-jsonrpc": "9.0.1" },
      'import "vscode-jsonrpc";\n',
    );
    await addWorkspace(
      root,
      "apps/graph-service",
      "@codegraph/graph-service",
      "composition-root",
      { "vscode-jsonrpc": "9.0.1" },
      'import "vscode-jsonrpc";\n',
    );

    await expect(checkDependencyBoundaries(root)).resolves.toEqual([]);
  });

  it.each([
    ["packages/contracts", "@codegraph/contracts", "contracts", "vscode-jsonrpc"],
    ["packages/service-client", "@codegraph/service-client", "service-client", "ajv"],
    ["apps/graph-service", "@codegraph/graph-service", "composition-root", "ajv"],
  ])(
    "rejects Story 1.2 dependencies assigned to the wrong role",
    async (relativePath, name, role, dependency) => {
      const root = await createRepository();
      await addWorkspace(
        root,
        relativePath,
        name,
        role,
        { [dependency]: "1.0.0" },
        `import "${dependency}";\n`,
      );

      await expectRule(root, "external-dependency-allowlist");
    },
  );

  it("rejects domain importing another project package", async () => {
    const root = await createRepository();
    await addWorkspace(root, "packages/contracts", "@codegraph/contracts", "contracts");
    await addWorkspace(
      root,
      "packages/domain",
      "@codegraph/domain",
      "domain",
      { "@codegraph/contracts": "workspace:*" },
      'import "@codegraph/contracts";\n',
    );

    await expectRule(root, "dependency-direction");
  });

  it("rejects application importing an adapter", async () => {
    const root = await createRepository();
    await addWorkspace(
      root,
      "packages/adapters/store-sqlite",
      "@codegraph/adapter-store-sqlite",
      "adapter",
    );
    await addWorkspace(
      root,
      "packages/application",
      "@codegraph/application",
      "application",
      { "@codegraph/adapter-store-sqlite": "workspace:*" },
      'import "@codegraph/adapter-store-sqlite";\n',
    );

    await expectRule(root, "dependency-direction");
  });

  it("rejects a core package reverse-importing an adapter", async () => {
    const root = await createRepository();
    await addWorkspace(
      root,
      "packages/adapters/git-local",
      "@codegraph/adapter-git-local",
      "adapter",
    );
    await addWorkspace(
      root,
      "packages/domain",
      "@codegraph/domain",
      "domain",
      { "@codegraph/adapter-git-local": "workspace:*" },
      'import "@codegraph/adapter-git-local";\n',
    );

    await expectRule(root, "dependency-direction");
  });

  it("rejects adapter composition outside graph-service", async () => {
    const root = await createRepository();
    await addWorkspace(
      root,
      "packages/adapters/analyzer-typescript",
      "@codegraph/adapter-analyzer-typescript",
      "adapter",
    );
    await addWorkspace(
      root,
      "apps/cli",
      "@codegraph/cli",
      "client-app",
      { "@codegraph/adapter-analyzer-typescript": "workspace:*" },
    );

    await expectRule(root, "dependency-direction");
  });

  it("rejects third-party dependencies that are not allowlisted for a role", async () => {
    const root = await createRepository();
    await addWorkspace(
      root,
      "packages/domain",
      "@codegraph/domain",
      "domain",
      { vscode: "1.125.0" },
      'import "vscode";\n',
    );

    await expectRule(root, "external-dependency-allowlist");
  });

  it("rejects workspace aliases and non-workspace protocols for internal packages", async () => {
    const root = await createRepository();
    await addWorkspace(root, "packages/domain", "@codegraph/domain", "domain");
    await addWorkspace(
      root,
      "packages/application",
      "@codegraph/application",
      "application",
      {
        "@codegraph/domain": "npm:@codegraph/domain@0.0.0",
        "domain-alias": "workspace:@codegraph/domain@*",
      },
    );

    await expectRule(root, "workspace-dependency-protocol");
    await expectRule(root, "workspace-dependency-alias");
  });

  it.each([
    'import contracts = require("@codegraph/contracts");\nvoid contracts;\n',
    'void import("@codegraph/contracts", { with: { type: "json" } });\n',
  ])("rejects forbidden imports expressed with additional TypeScript syntax", async (source) => {
    const root = await createRepository();
    await addWorkspace(root, "packages/contracts", "@codegraph/contracts", "contracts");
    await addWorkspace(root, "packages/domain", "@codegraph/domain", "domain", {}, source);

    await expectRule(root, "dependency-direction");
  });

  it("rejects a generic utils workspace", async () => {
    const root = await createRepository();
    await addWorkspace(root, "packages/utils", "@codegraph/utils", "domain");

    await expectRule(root, "no-generic-utils");
  });
});
