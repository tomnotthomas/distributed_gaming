import { defineConfig } from "vitest/config";

// Node, because this runs in the renter's session: child processes, Unix sockets, files.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
