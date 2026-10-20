import { defineConfig, devices } from "@playwright/test";

// End-to-end runs start from an empty local database each time.
const e2eDatabase = process.env.NEEDL_E2E_DATABASE_NAME ?? "needl_e2e";

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
    command: `dropdb --if-exists --force ${e2eDatabase} && createdb ${e2eDatabase} && npm run build && npm run serve`,
    url: "http://127.0.0.1:4173/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: `postgres://localhost:5432/${e2eDatabase}`,
      BETTER_AUTH_URL: "http://127.0.0.1:4173",
      NEEDL_TRUSTED_ORIGINS: "http://127.0.0.1:4173",
      BETTER_AUTH_SECRET: "needl-playwright-secret-that-is-long-enough",
      // npm run serve also reads the repo's .env; keep its real keys out of the tests.
      OPENAI_API_KEY: "",
      NEEDL_SIGNUP_ALLOWLIST: "",
    },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } } },
  ],
});
