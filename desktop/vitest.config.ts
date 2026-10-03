import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The renderer's screens and view-model under jsdom; the main process's pure
// helpers (pc.cjs) opt into node per file.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
  },
});
