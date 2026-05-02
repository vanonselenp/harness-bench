import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["hidden/tests/**/*.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 30000,
    reporters: ["json", "default"],
    outputFile: { json: "hidden/last-grade.json" },
  },
});
