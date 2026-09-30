import { defineConfig } from "vitest/config";

// jsdom, because this package is browser code: WebSocket, window timers, and
// — for @swiff/ui — rendered components.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
