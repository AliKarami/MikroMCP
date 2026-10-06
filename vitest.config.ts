import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8")) as { version: string };

export default defineConfig({
  define: {
    __MIKROMCP_VERSION__: JSON.stringify(version),
  },
  test: {
    globals: true,
    include: ["test/unit/**/*.test.ts"],
    // Many tests exercise error paths on purpose; their pino output only hides real failures.
    env: {
      MIKROMCP_LOG_LEVEL: "silent",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts"],
    },
  },
});
