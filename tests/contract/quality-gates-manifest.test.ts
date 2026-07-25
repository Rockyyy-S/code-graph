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
  it("登记唯一、升序、always-applicable 的十四项 blocking gate", async () => {
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
