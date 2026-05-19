import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __MIKROMCP_VERSION__: JSON.stringify(version),
  },
});
