import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:initializeResultSchema",
  evidenceId: "public-capability:schema:initializeResultSchema",
  fixturePath: "tests/fixtures/graph-bootstrap-initialize-v1.json",
  testPath: "tests/unit/graph-bootstrap-initialize-v1-capability.test.ts",
});
