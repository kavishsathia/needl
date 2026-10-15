import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./artifacts/playwright",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { outputFolder: "./artifacts/report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run build && npm run serve",
    url: "http://127.0.0.1:4173/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: "test",
      NEEDL_SQLITE_PATH: `.needl/e2e-${process.pid}.sqlite`,
      BETTER_AUTH_URL: "http://127.0.0.1:4173",
      NEEDL_TRUSTED_ORIGINS: "http://127.0.0.1:4173",
      BETTER_AUTH_SECRET: "needl-playwright-secret-that-is-long-enough",
    },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } } },
  ],
});
