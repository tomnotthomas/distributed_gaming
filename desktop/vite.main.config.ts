import { defineConfig } from "vite";

// The main process's error reports (src/mainErrors.ts), built for Node into
// dist/main-errors.cjs, which main.cjs requires. It runs after the window's
// build, which empties dist/, and bakes in VITE_POSTHOG_KEY and
// VITE_POSTHOG_HOST from the environment or desktop/.env (see .env.example).
export default defineConfig({
  build: {
    ssr: "src/mainErrors.ts",
    outDir: "dist",
    emptyOutDir: false,
    target: "node20",
    minify: false,
    rollupOptions: { output: { format: "cjs", entryFileNames: "main-errors.cjs" } },
  },
  // Bundle everything, the workspace package included: the packaged app has no node_modules.
  ssr: { noExternal: true },
});
