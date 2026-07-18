import { describe, expect, it, vi } from "vitest";
import { connectToGraphService } from "../../packages/service-client/src/connection.js";

describe("service-client trust gate", () => {
  it("performs no filesystem identity or launcher side effect when untrusted", async () => {
    const realpath = vi.fn(async (input: string) => input);
    const start = vi.fn();

    await expect(
      connectToGraphService({
        clientVersion: "0.0.0-test",
        identityOptions: { realpath },
        indexingRoot: "C:/untrusted",
        launcher: { start },
        trust: { isTrusted: false },
      }),
    ).rejects.toMatchObject({ code: "SERVICE_WORKSPACE_UNTRUSTED" });

    expect(realpath).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});
