import { defineConfig } from "@playwright/test";

// Test E2E działa w trybie demo (VITE_USE_MOCK=true): bez Supabase i bez kluczy API.
// Własna przeglądarka: ustaw PW_CHROMIUM_PATH (inaczej: npx playwright install chromium).
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:5174",
    acceptDownloads: true,
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: "npx vite --mode mock --port 5174 --strictPort",
    url: "http://localhost:5174",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
