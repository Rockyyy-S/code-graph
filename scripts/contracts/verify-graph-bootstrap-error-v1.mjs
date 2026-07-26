import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:errorV1Schema",
  evidenceId: "public-capability:schema:errorV1Schema",
  fixturePath: "tests/fixtures/graph-bootstrap-error-v1.json",
  testPath: "tests/unit/graph-bootstrap-error-v1-capability.test.ts",
});
