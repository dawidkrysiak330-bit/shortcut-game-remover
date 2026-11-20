import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test("pełny przepływ: fraza → ICP → wyszukiwanie → wyniki → karta → eksport", async ({ page }) => {
  const started = Date.now();
  await page.goto("/");
  await expect(page.getByText("TRYB DEMO")).toBeVisible();

  // 1) fraza → ICP
  await page.getByTestId("phrase").fill("palety drewniane EPAL");
  await page.getByTestId("gen-icp").click();
  const keywords = page.getByTestId("icp-keywords");
  await expect(keywords).toContainText("producent mebli");

  // 2) użytkownik edytuje ICP przed wyszukiwaniem
  await keywords.fill("producent mebli\nmagazyn logistyczny\nhurtownia");
  // 3) region obowiązkowy
  await page.getByTestId("start").click();
  await expect(page.getByText("Wybierz region")).toBeVisible();
  await page.getByTestId("region").selectOption("12"); // małopolskie
  await page.getByTestId("start").click();

  // postęp + koszt widoczny, potem przejście do wyników
  await expect(page.getByTestId("progress")).toBeVisible();
  await expect(page.getByTestId("cost")).toBeVisible();
  await page.waitForURL(/\/results\//);

  // ≥30 unikalnych firm (wykluczone ukryte domyślnie — odznaczamy filtr)
  await page.getByLabel("ukryj wykluczone (0%)").uncheck();
  const rows = page.getByTestId("results").locator("tbody tr");
  expect(await rows.count()).toBeGreaterThanOrEqual(30);
  expect(Date.now() - started).toBeLessThan(5 * 60_000);

  // filtr min. score
  await page.getByTestId("min-score").fill("60");
  const scores = await page.getByTestId("results").locator("tbody tr td:first-child").allInnerTexts();
  expect(scores.every((s) => parseInt(s) >= 60)).toBe(true);

  // eksport CSV: każde pole ma źródło, brak treści Google
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-csv").click()]);
  const csv = readFileSync(await download.path(), "utf-8");
  expect(csv).toContain("Źródła pól");
  expect(csv).toContain("gus_bir");
  expect(csv).not.toContain("google_places 20");

  // karta leada
  await page.getByTestId("results").locator("tbody tr a").first().click();
  await expect(page.getByTestId("lead-card")).toBeVisible();
  await expect(page.getByTestId("consent-warning")).toContainText("art. 398");
  await expect(page.getByTestId("components")).toContainText("Dopasowanie branży");
  await page.getByTestId("gen-card").click();
  await expect(page.getByText("Kąt rozmowy")).toBeVisible();
  // każdy wiersz w tabeli źródeł ma źródło i datę
  const srcRows = page.getByTestId("sources").locator("tbody tr");
  const n = await srcRows.count();
  expect(n).toBeGreaterThan(5);
  for (let i = 0; i < n; i++) {
    const cells = await srcRows.nth(i).locator("td").allInnerTexts();
    expect(cells[2].trim().length).toBeGreaterThan(0);
    expect(cells[3]).toMatch(/\d{4}-\d{2}-\d{2}/);
  }
});

test("przerwanie wyszukiwania", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("phrase").fill("palety");
  await page.getByTestId("gen-icp").click();
  await page.getByTestId("region").selectOption("12");
  await page.getByTestId("start").click();
  await page.getByRole("button", { name: "Przerwij wyszukiwanie" }).click();
  await expect(page.getByText("Przerwano.")).toBeVisible();
});
