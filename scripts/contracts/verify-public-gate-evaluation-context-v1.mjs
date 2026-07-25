import { runPublicCapabilityVerification } from "./run-public-capability-verification.mjs";

await runPublicCapabilityVerification({
  argv: process.argv.slice(2),
  capabilityId: "schema:gateEvaluationContextV1Schema",
  evidenceId: "public-capability:schema:gateEvaluationContextV1Schema",
  fixturePath: "tests/fixtures/public-gate-evaluation-context-v1.json",
  testPath: "tests/unit/public-gate-evaluation-context-v1-capability.test.ts",
});
