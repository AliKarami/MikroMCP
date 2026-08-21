import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

export default defineConfig({
  define: {
    __MIKROMCP_VERSION__: JSON.stringify(version),
  },
  test: {
    globals: true,
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    // Every test file talks to the same live CHR instance — parallel files
    // would race on shared router state.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      MIKROMCP_LOG_LEVEL: "error",
    },
  },
});
