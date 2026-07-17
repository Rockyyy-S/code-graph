const allowedRoleTargets = new Map([
  ["domain", new Set()],
  ["application", new Set(["domain"])],
  ["contracts", new Set()],
  ["service-client", new Set(["contracts"])],
  ["adapter", new Set(["application", "domain"])],
  ["composition-root", new Set(["application", "adapter", "contracts"])],
  ["client-app", new Set(["contracts", "service-client"])],
  ["renderer-app", new Set(["contracts"])],
]);

export function expectedRoleForWorkspace(relativePath) {
  if (relativePath === "packages/domain") {
    return "domain";
  }
  if (relativePath === "packages/application") {
    return "application";
  }
  if (relativePath === "packages/contracts") {
    return "contracts";
  }
  if (relativePath === "packages/service-client") {
    return "service-client";
  }
  if (relativePath.startsWith("packages/adapters/")) {
    return "adapter";
  }
  if (relativePath === "apps/graph-service") {
    return "composition-root";
  }
  if (relativePath === "apps/cli" || relativePath === "apps/extension") {
    return "client-app";
  }
  if (relativePath === "apps/webview") {
    return "renderer-app";
  }
  return null;
}

export function isDependencyAllowed(sourceRole, targetRole) {
  return allowedRoleTargets.get(sourceRole)?.has(targetRole) ?? false;
}

export function dependencySuggestion(sourceRole, targetRole) {
  if (sourceRole === "domain") {
    return "keep domain independent; move the concept into domain or map it at an outer layer";
  }
  if (sourceRole === "application" && targetRole === "adapter") {
    return "define an application-owned port and inject the adapter from apps/graph-service";
  }
  if (targetRole === "adapter") {
    return "remove the adapter dependency; compose adapters only in apps/graph-service";
  }
  if (sourceRole === "renderer-app") {
    return "move shared wire shapes to packages/contracts and keep filesystem/service access outside webview";
  }
  return "move the code to the owning package or invert the dependency through an allowed inner-layer contract";
}
