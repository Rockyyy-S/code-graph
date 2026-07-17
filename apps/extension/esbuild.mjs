import * as esbuild from "esbuild";

const production = process.argv.includes("--production");

if (production) {
  throw new Error("controlled build failure");
}

await esbuild.build({
  bundle: true,
  entryPoints: ["src/extension.ts"],
  external: ["vscode"],
  format: "cjs",
  logLevel: "info",
  minify: production,
  outfile: "dist/extension.js",
  platform: "node",
  sourcemap: !production,
  sourcesContent: false,
});
