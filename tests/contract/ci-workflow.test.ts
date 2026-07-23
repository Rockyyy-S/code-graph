import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const workflowPath = path.join(
  repositoryRoot,
  ".github/workflows/architecture-required.yml",
);
const producerSha = "d69682a9b4342acaa7048eaf664a77e8d35e1da1";

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
