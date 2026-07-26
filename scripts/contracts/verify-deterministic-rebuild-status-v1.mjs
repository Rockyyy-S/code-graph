import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:serviceStatusV1Schema",
  evidenceId: "public-capability:schema:serviceStatusV1Schema",
  fixturePath: "tests/fixtures/deterministic-rebuild-status-v1.json",
  testPath: "tests/unit/deterministic-rebuild-status-v1-capability.test.ts",
});
