import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:jobStartResultV1Schema",
  evidenceId: "public-capability:schema:jobStartResultV1Schema",
  fixturePath: "tests/fixtures/deterministic-rebuild-job-result-v1.json",
  testPath: "tests/unit/deterministic-rebuild-job-result-v1-capability.test.ts",
});
