import type { ExtensionContext } from "vscode";

/**
 * Story 1.1 intentionally performs no registration or I/O during activation.
 * Product capabilities are introduced only by their owning later stories.
 */
export function activate(_context: ExtensionContext): void {}

export function deactivate(): void {}
