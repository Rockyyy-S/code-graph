import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:serviceStatusV1CompatibleSchema",
  evidenceId: "public-capability:schema:serviceStatusV1CompatibleSchema",
  fixturePath: "tests/fixtures/graph-bootstrap-status-compatible-v1.json",
  testPath: "tests/unit/graph-bootstrap-status-compatible-v1-capability.test.ts",
});
