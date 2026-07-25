import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "rpc:job/start",
  evidenceId: "public-capability:rpc:job/start",
  fixturePath: "tests/fixtures/graph-bootstrap-rpc-v1.json",
  testPath: "tests/unit/graph-bootstrap-rpc-v1-capability.test.ts",
});
