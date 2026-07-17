import { describe, expect, it } from "vitest";
import {
  QUALITY_GATES,
  runArchitectureRequired,
} from "../../scripts/ci/run-architecture-required.mjs";

function commandsWithFailure(failingGate?: string) {
  return QUALITY_GATES.map((gate) => ({
    args: ["-e", `process.exit(${gate === failingGate ? 23 : 0})`],
    command: process.execPath,
    gate,
  }));
}

describe("architecture-required failure propagation", () => {
  for (const gate of QUALITY_GATES) {
    it(`returns non-zero when ${gate} returns non-zero`, () => {
      expect(
        runArchitectureRequired(commandsWithFailure(gate), { stdio: "pipe" }),
      ).toBe(23);
    });
  }

  it("returns zero only when every real child process succeeds", () => {
    expect(runArchitectureRequired(commandsWithFailure(), { stdio: "pipe" })).toBe(0);
  });
});
