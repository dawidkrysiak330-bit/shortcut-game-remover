/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Frontend importuje wspólną logikę (scoring, dedup, schematy) z katalogu Edge Functions.
// Tryb "artifact" (podgląd online): biblioteka Excel podmieniona na zaślepkę (pobieranie plików
// i tak nie działa w podglądzie), żeby cała aplikacja zmieściła się w jednym pliku.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./supabase/functions/_shared/core", import.meta.url)),
      ...(mode === "artifact" ? { exceljs: fileURLToPath(new URL("./src/lib/exceljs-stub.ts", import.meta.url)) } : {}),
    },
  },
  build: mode === "artifact" ? { rolldownOptions: { output: { inlineDynamicImports: true } } } : {},
  server: { port: 5173 },
  test: { include: ["tests/unit/**/*.test.ts"] },
}));
