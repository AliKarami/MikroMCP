import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

// Stub node:sqlite so pkg can produce a self-contained binary.
// undici conditionally imports it; pkg (5.x) doesn't recognise node:sqlite
// as a built-in (added in Node 22.5) and tries to open it as a file.
const stubNodeSqlite = {
  name: "stub-node-sqlite",
  setup(build: { onResolve: Function; onLoad: Function }) {
    build.onResolve({ filter: /^node:sqlite$/ }, () => ({
      path: "node:sqlite",
      namespace: "stub",
    }));
    build.onLoad({ filter: /^node:sqlite$/, namespace: "stub" }, () => ({
      contents: "export default {}",
      loader: "js",
    }));
  },
};

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  // Bundle all npm packages into a single file so pkg doesn't need to
  // resolve node_modules at binary-packaging time.
  noExternal: [/.*/],
  banner: {
    js: "#!/usr/bin/env node",
  },
  define: {
    __MIKROMCP_VERSION__: JSON.stringify(version),
  },
  esbuildOptions(options) {
    options.plugins = [stubNodeSqlite, ...(options.plugins ?? [])];
  },
});
