import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:initializeResultCompatibleSchema",
  evidenceId: "public-capability:schema:initializeResultCompatibleSchema",
  fixturePath: "tests/fixtures/deterministic-rebuild-initialize-compatible-v1.json",
  testPath: "tests/unit/deterministic-rebuild-initialize-compatible-v1-capability.test.ts",
});
