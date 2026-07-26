import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:jobStartRequestV1Schema",
  evidenceId: "public-capability:schema:jobStartRequestV1Schema",
  fixturePath: "tests/fixtures/graph-bootstrap-job-request-v1.json",
  testPath: "tests/unit/graph-bootstrap-job-request-v1-capability.test.ts",
});
