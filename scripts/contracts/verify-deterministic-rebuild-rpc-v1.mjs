import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "rpc:job/start",
  evidenceId: "public-capability:rpc:job/start",
  fixturePath: "tests/fixtures/deterministic-rebuild-rpc-v1.json",
  testPath: "tests/unit/deterministic-rebuild-rpc-v1-capability.test.ts",
});
