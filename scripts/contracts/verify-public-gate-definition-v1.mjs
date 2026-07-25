import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:gateDefinitionV1Schema",
  evidenceId: "public-capability:schema:gateDefinitionV1Schema",
  fixturePath: "tests/fixtures/public-gate-definition-v1.json",
  testPath: "tests/unit/public-gate-definition-v1-capability.test.ts",
});
