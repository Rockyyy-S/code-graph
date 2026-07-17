import type { ExtensionContext } from "vscode";

/**
 * 激活扩展。
 *
 * 本用户故事在激活期间不注册任何能力，也不执行 I/O；产品能力仅由后续所属用户故事引入。
 *
 * @param _context - VS Code 扩展上下文；当前壳层有意不使用。
 */
export function activate(_context: ExtensionContext): void {}

/**
 * 停用扩展。
 *
 * 当前壳层未持有需要释放的资源。
 */
export function deactivate(): void {}
