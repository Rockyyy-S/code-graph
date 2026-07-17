# VS Code extension 模板来源

- 生成器：`generator-code@1.12.0`（Microsoft 官方 `vscode-generator-code`）
- 模板：TypeScript extension
- 包管理器：pnpm
- bundler：esbuild
- 权威生成命令：

  ```text
  yo code <temporary-directory> --extensionType=ts --quick --pkgManager=pnpm --bundler=esbuild --no-gitInit --extensionId=codegraph --extensionDescription="Local-first code structure intelligence" --skip-install
  ```

## 生成后调整

- 将生成结果放入 monorepo 的 `apps/extension` workspace，并复用根级锁定工具链。
- 将 `engines.vscode` 固定为 `^1.125.0`，将 `@types/vscode`、esbuild、TypeScript 改为精确锁定版本。
- 删除 Hello World command、示例测试、Mocha/VS Code Electron 测试依赖和模板占位文案。
- 保留 esbuild 的 CJS bundle、`vscode` external 和 `dist/extension.js` 输出约定。
- 激活函数保持无副作用；模板 UI 不代表任何产品 UX 已完成。
- 生成时使用 `--no-gitInit`，仓库内未复制或创建嵌套 `.git`。

`generator-code@1.12.0` 的 README 将 bundler 选项写作 `--bundle`，但该版本源码实际读取 `--bundler`；以上命令按实际实现记录，合同测试验证 esbuild 输出。
