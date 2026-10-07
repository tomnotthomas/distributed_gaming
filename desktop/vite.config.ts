import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Electron loads the build off disk with file://, so assets must be relative.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  // Workspace packages ship TypeScript source; let Vite compile them.
  optimizeDeps: { exclude: ["@swiff/rtc", "@swiff/error-tracking"] },
});
