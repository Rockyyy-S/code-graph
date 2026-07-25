import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:gateRegistryV1Schema",
  evidenceId: "public-capability:schema:gateRegistryV1Schema",
  fixturePath: "tests/fixtures/public-gate-registry-v1.json",
  testPath: "tests/unit/public-gate-registry-v1-capability.test.ts",
});
