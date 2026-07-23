import { expect, it } from "vitest";

it("Story 1.3 provider 受控失败传播 fixture", () => {
  expect("child-failure").toBe("provider-pass");
});
