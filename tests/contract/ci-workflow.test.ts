import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadQualityGateRegistry } from "../../scripts/ci/load-quality-gates.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const workflowPath = path.join(
  repositoryRoot,
  ".github/workflows/architecture-required.yml",
);
const producerIdentityPattern =
  /^gha-oidc:\/\/1303415307\/Rockyyy-S\/code-graph-gate-controller\/\.github\/workflows\/produce-gate-evidence\.yml@([a-f0-9]{40})#([a-z][a-z0-9-]*)$/u;

/** 从全部 gate evidenceProducerId 解析唯一 producer SHA，清单是唯一机器权威。 */
async function loadManifestProducerSha(): Promise<string> {
  const loaded = await loadQualityGateRegistry(repositoryRoot);
  const producerShas = new Set<string>(loaded.registry.gates.map(({
    gateDefinition,
  }: {
    gateDefinition: { evidenceProducerId: string; gateId: string };
  }) => {
    const match = producerIdentityPattern.exec(gateDefinition.evidenceProducerId);
    if (match === null || match[2] !== gateDefinition.gateId) {
      throw new Error(`gate ${gateDefinition.gateId} producer identity 无法解析。`);
    }
    return match[1]!;
  }));
  if (producerShas.size !== 1) {
    throw new Error("ci/quality-gates.v1.yaml 必须绑定唯一 producer SHA。");
  }
  return [...producerShas][0]!;
}

describe("child gate evidence workflow", () => {
  it("runs on every pull request and protected default-branch push", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("push:");
    expect(workflow).toContain("- main");
    expect(workflow).not.toMatch(/paths(?:-ignore)?:/u);
  });

  it("delegates to the immutable external producer with provider OID inputs", async () => {
    const workflow = await readFile(workflowPath, "utf8");
    const producerSha = await loadManifestProducerSha();

    expect(workflow).toContain(
      `uses: Rockyyy-S/code-graph-gate-controller/.github/workflows/produce-gate-evidence.yml@${producerSha}`,
    );
    expect(workflow).toContain("provider_repository_id:");
    expect(workflow).toContain(`producer_workflow_sha: ${producerSha}`);
    expect(workflow).toContain("repository:");
    expect(workflow).toContain("base_oid:");
    expect(workflow).toContain("head_oid:");
    expect(workflow).toContain("object_format: sha1");
    expect(workflow).not.toMatch(/secrets:\s*inherit/u);
  });

  it("publishes only child evidence and cannot self-publish the umbrella check", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toMatch(/jobs:\s+gate-evidence:/su);
    expect(workflow).not.toMatch(/jobs:\s+architecture-required:/su);
    expect(workflow).not.toMatch(/name:\s+architecture-required/u);
    expect(workflow).not.toMatch(/continue-on-error|\|\|\s*true/u);
    expect(workflow).not.toMatch(/^\s+run:/mu);
    expect(workflow.match(/uses:\s+[^\s]+@[0-9a-f]{40}/gu)).toHaveLength(1);
  });
});
