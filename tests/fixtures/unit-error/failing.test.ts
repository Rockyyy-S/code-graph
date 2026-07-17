import { expect, it } from "vitest";

it("propagates a real failed assertion", () => {
  expect(1).toBe(2);
});
