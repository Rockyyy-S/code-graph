import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadQualityGateRegistry,
  validateQualityGateRegistry,
} from "../../scripts/ci/load-quality-gates.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const workflowSha = "c01e7c0550b9d9150df26c20cebb10aaefdf648d";
const temporaryRoots: string[] = [];

const expectedGates = [
  ["basic-security", ["pnpm", "basic-security"], "security"],
  ["build", ["pnpm", "build"], "dev-enablement"],
  ["contract", ["pnpm", "contract"], "qa"],
  ["dependency-boundary", ["pnpm", "dependency-boundary"], "architecture"],
  [
    "graph-bootstrap-error-v1",
    ["node", "scripts/contracts/verify-graph-bootstrap-error-v1.mjs", "--capability", "schema:errorV1Schema", "--test", "tests/unit/graph-bootstrap-error-v1-capability.test.ts", "--fixture", "tests/fixtures/graph-bootstrap-error-v1.json", "--evidence-id", "public-capability:schema:errorV1Schema"],
    "qa",
  ],
  [
    "graph-bootstrap-initialize-compatible-v1",
    ["node", "scripts/contracts/verify-graph-bootstrap-initialize-compatible-v1.mjs", "--capability", "schema:initializeResultCompatibleSchema", "--test", "tests/unit/graph-bootstrap-initialize-compatible-v1-capability.test.ts", "--fixture", "tests/fixtures/graph-bootstrap-initialize-compatible-v1.json", "--evidence-id", "public-capability:schema:initializeResultCompatibleSchema"],
    "qa",
  ],
  [
    "graph-bootstrap-initialize-v1",
    ["node", "scripts/contracts/verify-graph-bootstrap-initialize-v1.mjs", "--capability", "schema:initializeResultSchema", "--test", "tests/unit/graph-bootstrap-initialize-v1-capability.test.ts", "--fixture", "tests/fixtures/graph-bootstrap-initialize-v1.json", "--evidence-id", "public-capability:schema:initializeResultSchema"],
    "qa",
  ],
  [
    "graph-bootstrap-job-request-v1",
    ["node", "scripts/contracts/verify-graph-bootstrap-job-request-v1.mjs", "--capability", "schema:jobStartRequestV1Schema", "--test", "tests/unit/graph-bootstrap-job-request-v1-capability.test.ts", "--fixture", "tests/fixtures/graph-bootstrap-job-request-v1.json", "--evidence-id", "public-capability:schema:jobStartRequestV1Schema"],
    "qa",
  ],
  [
    "graph-bootstrap-job-result-v1",
    ["node", "scripts/contracts/verify-graph-bootstrap-job-result-v1.mjs", "--capability", "schema:jobStartResultV1Schema", "--test", "tests/unit/graph-bootstrap-job-result-v1-capability.test.ts", "--fixture", "tests/fixtures/graph-bootstrap-job-result-v1.json", "--evidence-id", "public-capability:schema:jobStartResultV1Schema"],
    "qa",
  ],
  [
    "graph-bootstrap-rpc-v1",
    ["node", "scripts/contracts/verify-graph-bootstrap-rpc-v1.mjs", "--capability", "rpc:job/start", "--test", "tests/unit/graph-bootstrap-rpc-v1-capability.test.ts", "--fixture", "tests/fixtures/graph-bootstrap-rpc-v1.json", "--evidence-id", "public-capability:rpc:job/start"],
    "qa",
  ],
  [
    "graph-bootstrap-status-compatible-v1",
    ["node", "scripts/contracts/verify-graph-bootstrap-status-compatible-v1.mjs", "--capability", "schema:serviceStatusV1CompatibleSchema", "--test", "tests/unit/graph-bootstrap-status-compatible-v1-capability.test.ts", "--fixture", "tests/fixtures/graph-bootstrap-status-compatible-v1.json", "--evidence-id", "public-capability:schema:serviceStatusV1CompatibleSchema"],
    "qa",
  ],
  [
    "graph-bootstrap-status-v1",
    ["node", "scripts/contracts/verify-graph-bootstrap-status-v1.mjs", "--capability", "schema:serviceStatusV1Schema", "--test", "tests/unit/graph-bootstrap-status-v1-capability.test.ts", "--fixture", "tests/fixtures/graph-bootstrap-status-v1.json", "--evidence-id", "public-capability:schema:serviceStatusV1Schema"],
    "qa",
  ],
  ["lint", ["pnpm", "lint"], "dev-enablement"],
  ["planning-traceability", ["pnpm", "planning-trace"], "architecture-po"],
  [
    "public-gate-definition-v1",
    ["node", "scripts/contracts/verify-public-gate-definition-v1.mjs", "--capability", "schema:gateDefinitionV1Schema", "--test", "tests/unit/public-gate-definition-v1-capability.test.ts", "--fixture", "tests/fixtures/public-gate-definition-v1.json", "--evidence-id", "public-capability:schema:gateDefinitionV1Schema"],
    "qa",
  ],
  [
    "public-gate-evaluation-context-v1",
    ["node", "scripts/contracts/verify-public-gate-evaluation-context-v1.mjs", "--capability", "schema:gateEvaluationContextV1Schema", "--test", "tests/unit/public-gate-evaluation-context-v1-capability.test.ts", "--fixture", "tests/fixtures/public-gate-evaluation-context-v1.json", "--evidence-id", "public-capability:schema:gateEvaluationContextV1Schema"],
    "qa",
  ],
  [
    "public-gate-evidence-v1",
    ["node", "scripts/contracts/verify-public-gate-evidence-v1.mjs", "--capability", "schema:gateEvidenceV1Schema", "--test", "tests/unit/public-gate-evidence-v1-capability.test.ts", "--fixture", "tests/fixtures/public-gate-evidence-v1.json", "--evidence-id", "public-capability:schema:gateEvidenceV1Schema"],
    "qa",
  ],
  [
    "public-gate-output-v1",
    ["node", "scripts/contracts/verify-public-gate-output-v1.mjs", "--capability", "schema:gateOutputV1Schema", "--test", "tests/unit/public-gate-output-v1-capability.test.ts", "--fixture", "tests/fixtures/public-gate-output-v1.json", "--evidence-id", "public-capability:schema:gateOutputV1Schema"],
    "qa",
  ],
  [
    "public-gate-registry-v1",
    ["node", "scripts/contracts/verify-public-gate-registry-v1.mjs", "--capability", "schema:gateRegistryV1Schema", "--test", "tests/unit/public-gate-registry-v1-capability.test.ts", "--fixture", "tests/fixtures/public-gate-registry-v1.json", "--evidence-id", "public-capability:schema:gateRegistryV1Schema"],
    "qa",
  ],
  [
    "repository-contract-preflight",
    ["node", "scripts/contracts/validate-repository-contract.mjs"],
    "dev-enablement",
  ],
  ["type", ["pnpm", "type"], "dev-enablement"],
  ["unit", ["pnpm", "unit"], "qa"],
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("quality-gates.v1 registry", () => {
  it("登记唯一、升序、always-applicable 的二十二项 blocking gate", async () => {
    const loaded = await loadQualityGateRegistry(repositoryRoot);

    expect(loaded.gateRegistryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded.registry.gates).toHaveLength(expectedGates.length);
    expectedGates.forEach(([gateId, command, capabilityOwner], index) => {
      const entry = loaded.registry.gates[index]!;
      expect(entry.gateDefinition).toEqual({
        blocking: true,
        capabilityOwner,
        checkId: gateId,
        command,
        evidenceProducerId: `gha-oidc://1303415307/Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@${workflowSha}#${gateId}`,
        gateId,
      });
      expect(entry.gateDefinitionDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.hasOwn(entry.gateDefinition, "triggerPaths")).toBe(false);
    });
  });

  it.each([
    ["unknown root field", (registry: Record<string, unknown>) => ({ ...registry, unknown: true })],
    [
      "definition digest drift",
      (registry: Record<string, unknown>) => {
        const copy = structuredClone(registry) as {
          gates: Array<{ gateDefinitionDigest: string }>;
        };
        copy.gates[0]!.gateDefinitionDigest = "0".repeat(64);
        return copy;
      },
    ],
    [
      "no-op command",
      (registry: Record<string, unknown>) => {
        const copy = structuredClone(registry) as {
          gates: Array<{ gateDefinition: { command: string[] } }>;
        };
        copy.gates[0]!.gateDefinition.command = ["true"];
        return copy;
      },
    ],
    [
      "attached node inline command",
      (registry: Record<string, unknown>) => {
        const copy = structuredClone(registry) as {
          gates: Array<{ gateDefinition: { command: string[] } }>;
        };
        copy.gates[0]!.gateDefinition.command = ["node", "--eval=process.exit(0)"];
        return copy;
      },
    ],
    [
      "unsorted gates",
      (registry: Record<string, unknown>) => {
        const copy = structuredClone(registry) as { gates: unknown[] };
        [copy.gates[0], copy.gates[1]] = [copy.gates[1], copy.gates[0]];
        return copy;
      },
    ],
  ])("拒绝 %s", async (_label, mutate) => {
    const loaded = await loadQualityGateRegistry(repositoryRoot);
    expect(() => validateQualityGateRegistry(mutate(loaded.registry))).toThrow();
  });

  it("从隔离根目录读取固定 ci/quality-gates.v1.yaml，而不扫描其他清单", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-gate-registry-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "ci"), { recursive: true });
    await writeFile(
      path.join(root, "ci", "quality-gates.v1.yaml"),
      JSON.stringify({ gates: [], schemaVersion: 1 }),
      "utf8",
    );

    await expect(loadQualityGateRegistry(root)).rejects.toThrow(/gates/u);
  });
});
