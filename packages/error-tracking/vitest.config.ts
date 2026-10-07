import { defineConfig } from "vitest/config";

// Plain node: scrubbing and reports are data in, data out; sending is a fake.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
