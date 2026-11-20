import { defineConfig } from "@playwright/test";

// Testy w trybie demo (dane fikcyjne, bez Google). Własna przeglądarka: PW_CHROMIUM_PATH.
export default defineConfig({
  testDir: "tests",
  testMatch: "*.spec.ts",
  timeout: 90_000,
  use: {
    baseURL: "http://localhost:8799",
    acceptDownloads: true,
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: { command: "node src/server.ts --demo", url: "http://localhost:8799/api/config", env: { PORT: "8799" }, reuseExistingServer: false },
});
