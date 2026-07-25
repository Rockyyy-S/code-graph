import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:gateOutputV1Schema",
  evidenceId: "public-capability:schema:gateOutputV1Schema",
  fixturePath: "tests/fixtures/public-gate-output-v1.json",
  testPath: "tests/unit/public-gate-output-v1-capability.test.ts",
});
