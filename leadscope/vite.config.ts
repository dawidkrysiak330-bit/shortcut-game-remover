/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Frontend importuje wspólną logikę (scoring, dedup, schematy) z katalogu Edge Functions.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@core": fileURLToPath(new URL("./supabase/functions/_shared/core", import.meta.url)) },
  },
  server: { port: 5173 },
  test: { include: ["tests/unit/**/*.test.ts"] },
});
