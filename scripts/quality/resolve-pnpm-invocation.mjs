import path from "node:path";

/**
 * 将 pnpm 的 npm_execpath 收敛为 shell:false 的受控执行形状。
 *
 * pnpm SEA 可能只暴露相对命令名 `pnpm`；只有绝对 JavaScript launcher 才交给
 * 当前 Node 执行，绝对原生可执行文件直接运行，其他相对值一律 fail closed。
 */
export function createPnpmInvocation(npmExecPath, args) {
  if (typeof npmExecPath !== "string" || npmExecPath.length === 0) {
    return { args, executable: "pnpm" };
  }
  if (path.isAbsolute(npmExecPath) || path.win32.isAbsolute(npmExecPath)) {
    const extension = path.extname(npmExecPath).toLowerCase();
    if ([".cmd", ".bat"].includes(extension)) {
      if (!/^pnpm(?:\.cmd|\.bat)$/iu.test(path.win32.basename(npmExecPath))) {
        throw new Error("package.json: npm_execpath 的 Windows script shim 不是受控 pnpm launcher。\n");
      }
      const commandLine = buildWindowsCommandLine(npmExecPath, args);
      return {
        args: ["/d", "/s", "/c", commandLine],
        executable: process.env.ComSpec ?? "cmd.exe",
        windowsVerbatimArguments: true,
      };
    }
    return [".cjs", ".js", ".mjs"].includes(extension)
      ? { args: [npmExecPath, ...args], executable: process.execPath }
      : { args, executable: npmExecPath };
  }
  if (npmExecPath !== "pnpm") {
    throw new Error("package.json: pnpm 提供了非法的相对 npm_execpath。\n");
  }
  return { args, executable: "pnpm" };
}

/** 为 cmd.exe /d /s /c 构造单一、封闭的 pnpm shim 命令行。 */
function buildWindowsCommandLine(executable, args) {
  const tokens = [executable, ...args].map(quoteWindowsCommandArgument);
  return `"${tokens.join(" ")}"`;
}

/** 引号、换行及 cmd.exe 的百分号/延迟展开字符不得进入 Windows command shim。 */
function quoteWindowsCommandArgument(value) {
  if (typeof value !== "string" || /[\0\r\n"!%]/u.test(value)) {
    throw new Error("package.json: pnpm Windows launcher 参数包含不安全字符。\n");
  }
  return `"${value}"`;
}
