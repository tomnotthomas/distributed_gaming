import { defineConfig } from "vitest/config";

// Node, because this is a Linux daemon: child processes, Unix sockets, files.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The integration test starts the real server, which first boots an
    // in-memory Postgres: slow while the other workspaces' suites load the machine.
    hookTimeout: 90_000,
  },
});
