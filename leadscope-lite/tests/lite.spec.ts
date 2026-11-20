import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

test("frazy → wyniki → www → Biała lista → eksport CSV bez treści Google", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("TRYB DEMO")).toBeVisible();
  await page.locator("#phrases").fill("producent mebli\nmagazyn logistyczny");
  await page.locator("#start").click();
  await expect(page.locator("#msg")).toContainText("województwo"); // region obowiązkowy
  await page.locator("#region").selectOption("12");
  await page.locator("#bl").check();
  await page.locator("#start").click();
  await expect(page.locator("#stage")).toContainText("Gotowe", { timeout: 80_000 });

  const rows = page.locator("#table tbody tr");
  expect(await rows.count()).toBeGreaterThanOrEqual(30);
  // ta sama firma z dwóch fraz = jeden wiersz
  await expect(page.locator("#table tbody")).toContainText("producent mebli, magazyn logistyczny");
  // robots.txt i blokada 403 są respektowane
  await expect(page.locator("#table tbody")).toContainText("robots.txt nie pozwala");
  await expect(page.locator("#table tbody")).toContainText("blokuje automatyczne pobieranie");
  // tylko rolowe e-maile
  await expect(page.locator("#table tbody")).toContainText("biuro@firma-1.example");
  await expect(page.locator("#table tbody")).not.toContainText("jan.kowalski");
  // firma spoza województwa odfiltrowana (mock: co 15. jest w śląskim)
  await expect(page.locator("#table tbody")).not.toContainText("Firma Testowa 15 ");

  await page.locator("#onlyNip").check();
  const withNip = await rows.count();
  expect(withNip).toBeGreaterThan(0);

  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator("#export button").click()]);
  const csv = readFileSync(await dl.path(), "utf-8");
  expect(csv).toContain("Link do Google Maps");
  expect(csv).toContain("place_id:mock_1");
  expect(csv).toContain("biuro@firma-1.example");
  expect(csv).not.toContain("Firma Testowa 1 ("); // nazwa z Google nie trafia do eksportu
  expect(csv).not.toContain("ul. Testowa"); // adres z Google też nie
});

test("przerwanie wyszukiwania", async ({ page }) => {
  await page.goto("/");
  await page.locator("#phrases").fill("producent mebli");
  await page.locator("#region").selectOption("12");
  await page.locator("#start").click();
  await page.locator("#cancel").click();
  await expect(page.locator("#stage")).toContainText("Przerwane", { timeout: 30_000 });
});
