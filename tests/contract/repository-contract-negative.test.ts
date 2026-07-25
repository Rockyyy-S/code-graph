import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateRepositoryContract } from "../../scripts/contracts/validate-repository-contract.mjs";
import { sha256CanonicalJson } from "../../packages/contracts/runtime/canonical-json.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function writeJson(
  root: string,
  relativePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(value), "utf8");
}

async function createValidContractFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codegraph-contract-fixture-"));
  temporaryRoots.push(root);
  const scripts = Object.fromEntries(
    Object.entries({
      "basic-security": "node scripts/security/check-basic-security.mjs",
      build: "node scripts/quality/run-workspace-script.mjs build",
      contract: "vitest run --config vitest.contract.config.ts",
      "dependency-boundary": "node scripts/architecture/check-dependency-boundaries.mjs",
      lint: "eslint . --max-warnings=0 --no-warn-ignored --format ./scripts/quality/relative-eslint-formatter.mjs && node scripts/quality/check-test-markers.mjs",
      type: "node scripts/quality/run-workspace-script.mjs type && tsc --noEmit -p tsconfig.quality.json",
      unit: "node scripts/quality/check-test-markers.mjs && vitest run --config vitest.config.ts",
    }),
  );
  const rootScripts = {
    ...scripts,
    "architecture-required": "node scripts/ci/run-architecture-required.mjs",
  };

  await writeJson(root, "package.json", {
    devDependencies: { typescript: "6.0.3" },
    engines: { node: "24.18.0", pnpm: "11.12.0" },
    packageManager: "pnpm@11.12.0",
    scripts: rootScripts,
  });
  await writeFile(path.join(root, ".node-version"), "24.18.0\n", "utf8");
  await writeFile(path.join(root, ".nvmrc"), "24.18.0\n", "utf8");
  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - 'packages/adapters/*'\n",
    "utf8",
  );
  await writeJson(root, "apps/extension/package.json", {
    devDependencies: {
      "@types/vscode": "1.125.0",
      esbuild: "0.28.1",
    },
    engines: { vscode: "^1.125.0" },
    name: "@codegraph/extension",
  });
  await writeJson(root, "packages/domain/package.json", {
    name: "@codegraph/domain",
  });
  const workflowSha = "1".repeat(40);
  const gates = Object.keys(scripts)
    .sort()
    .map((gateId) => {
      const gateDefinition = {
        blocking: true,
        capabilityOwner: "dev-enablement",
        checkId: gateId,
        command: ["pnpm", gateId],
        evidenceProducerId: `gha-oidc://1303415307/example/controller/.github/workflows/produce-gate-evidence.yml@${workflowSha}#${gateId}`,
        gateId,
      };
      return {
        gateDefinition,
        gateDefinitionDigest: sha256CanonicalJson(gateDefinition),
      };
    });
  await writeJson(root, "ci/quality-gates.v1.yaml", { gates, schemaVersion: 1 });
  return root;
}

async function readRootManifest(root: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function expectPortableViolation(
  violations: Array<{ relativePath: string; rule: string; suggestion: string }>,
  rule: string,
): void {
  const matching = violations.filter((violation) => violation.rule === rule);
  expect(matching.length).toBeGreaterThan(0);
  for (const violation of matching) {
    expect(violation.relativePath).not.toMatch(/^[A-Za-z]:/);
    expect(violation.suggestion.length).toBeGreaterThan(10);
  }
}

describe("repository contract negative paths", () => {
  it("rejects a missing root command", async () => {
    const root = await createValidContractFixture();
    const manifest = await readRootManifest(root);
    delete (manifest.scripts as Record<string, string>)["basic-security"];
    await writeJson(root, "package.json", manifest);

    const violations = await validateRepositoryContract(root);

    expectPortableViolation(violations, "root-script-contract");
  });

  it("rejects a root command replaced by a no-op", async () => {
    const root = await createValidContractFixture();
    const manifest = await readRootManifest(root);
    (manifest.scripts as Record<string, string>).type = 'node -e "process.exit(0)"';
    await writeJson(root, "package.json", manifest);

    const violations = await validateRepositoryContract(root);

    expectPortableViolation(violations, "root-script-contract");
  });

  it("accepts only the exact capability verification Node argv declared by bindings", async () => {
    const root = await createValidContractFixture();
    const capabilityId = "rpc:graph/query";
    const evidenceId = `public-capability:${capabilityId}`;
    const entryPath = "scripts/contracts/verify-graph-query.mjs";
    const testPath = "tests/contract/graph-query.contract.test.ts";
    const fixturePath = "tests/fixtures/graph-query.request.json";
    const assertionTarget = {
      exportName: "validateGraphQuery",
      modulePath: "packages/application/src/graph-query.ts",
    };
    const command = [
      "node",
      entryPath,
      "--capability",
      capabilityId,
      "--test",
      testPath,
      "--fixture",
      fixturePath,
      "--evidence-id",
      evidenceId,
    ];
    await writeJson(root, "ci/public-capability-gates.v1.json", {
      bindings: [{
        capabilityId,
        gateId: "graph-query-contract",
        verification: { assertionTarget, entryPath, evidenceId, fixturePath, testPath },
      }],
      schemaVersion: 1,
    });
    const absoluteEntry = path.join(root, ...entryPath.split("/"));
    await mkdir(path.dirname(absoluteEntry), { recursive: true });
    await writeFile(absoluteEntry, "// fixture entry\n", "utf8");
    const registryPath = path.join(root, "ci/quality-gates.v1.yaml");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      gates: Array<Record<string, unknown>>;
      schemaVersion: number;
    };
    const gateDefinition = {
      blocking: true,
      capabilityOwner: "qa",
      checkId: "graph-query-contract",
      command,
      evidenceProducerId: `gha-oidc://1303415307/example/controller/.github/workflows/produce-gate-evidence.yml@${"1".repeat(40)}#graph-query-contract`,
      gateId: "graph-query-contract",
    };
    registry.gates.push({
      gateDefinition,
      gateDefinitionDigest: sha256CanonicalJson(gateDefinition),
    });
    registry.gates.sort((left, right) => {
      const leftId = (left.gateDefinition as { gateId: string }).gateId;
      const rightId = (right.gateDefinition as { gateId: string }).gateId;
      return leftId.localeCompare(rightId);
    });
    await writeJson(root, "ci/quality-gates.v1.yaml", registry as Record<string, unknown>);

    const accepted = await validateRepositoryContract(root);
    expect(accepted.filter(({ rule }) => rule === "gate-command-contract")).toEqual([]);

    gateDefinition.command = [...command, "--extra"];
    const gate = registry.gates.find((entry) =>
      (entry.gateDefinition as { gateId: string }).gateId === "graph-query-contract"
    ) as { gateDefinition: typeof gateDefinition; gateDefinitionDigest: string };
    gate.gateDefinitionDigest = sha256CanonicalJson(gateDefinition);
    await writeJson(root, "ci/quality-gates.v1.yaml", registry as Record<string, unknown>);
    expectPortableViolation(await validateRepositoryContract(root), "gate-command-contract");
  });

  it("rejects toolchain version drift", async () => {
    const root = await createValidContractFixture();
    const manifest = await readRootManifest(root);
    (manifest.devDependencies as Record<string, string>).typescript = "7.0.2";
    await writeJson(root, "package.json", manifest);

    const violations = await validateRepositoryContract(root);

    expectPortableViolation(violations, "toolchain-version");
  });

  it("rejects a nested package that workspace discovery misses", async () => {
    const root = await createValidContractFixture();
    await writeJson(root, "packages/application/indexing/package.json", {
      name: "@codegraph/indexing",
    });

    const violations = await validateRepositoryContract(root);

    expectPortableViolation(violations, "undiscovered-workspace");
  });

  it("rejects additional pnpm workspace roots", async () => {
    const root = await createValidContractFixture();
    await writeFile(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - 'packages/adapters/*'\n  - 'tools/*'\n",
      "utf8",
    );

    const violations = await validateRepositoryContract(root);

    expectPortableViolation(violations, "workspace-roots");
  });

  it("rejects a lower VS Code engine floor", async () => {
    const root = await createValidContractFixture();
    await writeJson(root, "apps/extension/package.json", {
      devDependencies: {
        "@types/vscode": "1.125.0",
        esbuild: "0.28.1",
      },
      engines: { vscode: "^1.124.0" },
      name: "@codegraph/extension",
    });

    const violations = await validateRepositoryContract(root);

    expectPortableViolation(violations, "extension-version");
  });
});
