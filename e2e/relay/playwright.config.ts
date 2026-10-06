import { defineConfig } from "@playwright/test";

// The relay scenario only, run by e2e/relay/run.sh inside the network it
// builds: the spec starts its own servers and browsers, one in each network.
export default defineConfig({
  testDir: ".",
  testMatch: /relay\.spec\.ts/,
  outputDir: "../.results/relay/playwright",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
});
