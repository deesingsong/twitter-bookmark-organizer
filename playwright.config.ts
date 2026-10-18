import { config as loadEnv } from "dotenv";
import { defineConfig, devices } from "@playwright/test";
import { LOCAL_E2E_ORIGIN, requireLocalE2ETarget } from "./e2e/local-target";

loadEnv({ path: ".env.local" });

// Validate before Playwright starts Next or probes the application URL.
const target = requireLocalE2ETarget();
const baseURL = LOCAL_E2E_ORIGIN;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `${npm} run dev -- --hostname 127.0.0.1 --port 3100`,
    env: {
      DATABASE_URL: target.appConnectionString,
      DATABASE_URL_UNPOOLED: target.directConnectionString,
    },
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
