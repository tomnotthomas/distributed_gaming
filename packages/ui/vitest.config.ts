import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// jsdom, because this package is browser code: WebSocket, window timers, and
// — for @swiff/ui — rendered components.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
