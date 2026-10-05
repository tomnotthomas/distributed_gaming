import { defineConfig } from "vitest/config";

// Node, not jsdom: the streamer runs in Node, with Node's own WebSocket.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
