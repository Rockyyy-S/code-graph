import { describe, expect, it } from "vitest";
import { isDependencyAllowed } from "../../scripts/architecture/dependency-policy.mjs";

describe("dependency policy", () => {
  it("keeps dependencies flowing toward domain and contracts", () => {
    expect(isDependencyAllowed("domain", "contracts")).toBe(true);
    expect(isDependencyAllowed("application", "domain")).toBe(true);
    expect(isDependencyAllowed("application", "adapter")).toBe(false);
    expect(isDependencyAllowed("adapter", "application")).toBe(true);
    expect(isDependencyAllowed("service-client", "contracts")).toBe(true);
  });

  it("reserves adapter composition for graph-service", () => {
    expect(isDependencyAllowed("composition-root", "adapter")).toBe(true);
    expect(isDependencyAllowed("client-app", "adapter")).toBe(false);
    expect(isDependencyAllowed("renderer-app", "adapter")).toBe(false);
  });
});
