import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:errorV1Schema",
  evidenceId: "public-capability:schema:errorV1Schema",
  fixturePath: "tests/fixtures/deterministic-rebuild-error-v1.json",
  testPath: "tests/unit/deterministic-rebuild-error-v1-capability.test.ts",
});
