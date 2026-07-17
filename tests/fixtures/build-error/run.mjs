import { build } from "esbuild";

try {
  await build({
    bundle: true,
    entryPoints: ["src/index.ts"],
    outfile: "out/fixture.js",
    platform: "node",
  });
} catch (error) {
  // The fixture must propagate esbuild's real resolution failure to the caller.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
