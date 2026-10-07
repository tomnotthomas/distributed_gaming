import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  // Workspace packages ship TypeScript source; let Vite compile them.
  optimizeDeps: { exclude: ["@swiff/ui", "@swiff/rtc", "@swiff/rank", "@swiff/error-tracking"] },
});
