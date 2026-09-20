import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit and integration tests for the web app.
//
// Everything runs under jsdom, including the integration test that talks to a
// real signaling server: `signaling.ts` reaches for `window.setInterval` and
// `WebSocket`, and jsdom supplies both — the second one backed by a real socket,
// so the handshake under test is the genuine one.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // The integration test spawns a server and drives sockets; the default 5s
    // is tight on a cold CI runner.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/main.tsx"],
      reporter: ["text", "lcov"],
    },
  },
});
