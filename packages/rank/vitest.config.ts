import { defineConfig } from "vitest/config";

// Plain node: ranking is pure data in, data out, with no DOM and no clock.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
