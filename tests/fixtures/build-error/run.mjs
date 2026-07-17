import { build } from "esbuild";

try {
  await build({
    bundle: true,
    entryPoints: ["src/index.ts"],
    outfile: "out/fixture.js",
    platform: "node",
  });
} catch (error) {
  /** 测试夹具必须将 esbuild 的真实解析失败传播给调用方。 */
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
