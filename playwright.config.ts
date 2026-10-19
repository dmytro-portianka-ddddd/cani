import { defineConfig } from "@playwright/test";

/**
 * E2E for the Cani PWA. The webServer boots the real Bun app against a
 * throwaway data dir (seeded demo books), so specs run the true
 * browser → HTTP → decide() → ledger path, never a mock.
 * Run: bun run test:e2e   (first time: bunx playwright install chromium)
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  use: {
    testIdAttribute: "data-testid",
    baseURL: "http://127.0.0.1:8799",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  },
  webServer: {
    command: "bun run e2e:serve",
    url: "http://127.0.0.1:8799/api/state",
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: "8799",
      CANI_DATA_DIR: "e2e-data",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    },
  },
});
