import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:gateEvidenceV1Schema",
  evidenceId: "public-capability:schema:gateEvidenceV1Schema",
  fixturePath: "tests/fixtures/public-gate-evidence-v1.json",
  testPath: "tests/unit/public-gate-evidence-v1-capability.test.ts",
});
