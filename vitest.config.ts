import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

export default defineConfig({
  define: {
    __MIKROMCP_VERSION__: JSON.stringify(version),
  },
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts"],
    },
  },
});
