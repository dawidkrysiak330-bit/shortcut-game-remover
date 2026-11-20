import { describe, expect, it } from "vitest";
import { LeadCardLlmSchema, groundingErrors, extractJson } from "../../supabase/functions/_shared/core/schemas.ts";
import { mergeCluster } from "../../supabase/functions/_shared/core/dedup.ts";

const c = mergeCluster([{ source: "gus_bir", fetched_at: "2026-11-20T10:00:00Z", fields: { name: "Alfa", registration_date: "2015-03-01" } }],
  [{ url: "https://alfa.example", fetched_at: "2026-11-20T10:00:00Z", text: "Produkujemy meble od 2015 roku." }]);

describe("walidacja odpowiedzi LLM", () => {
  it("odrzuca JSON niezgodny ze schematem", () => {
    expect(LeadCardLlmSchema.safeParse({ description: "x" }).success).toBe(false);
  });
  it("odrzuca liczby spoza danych (halucynacja) i powołanie na brakujące pole", () => {
    const card = LeadCardLlmSchema.parse({
      description: "Firma zatrudnia 250 osób i produkuje meble od 2015 roku.",
      why_buy: [{ point: "Ma flotę ciężarówek.", evidence_field: "pkd" }],
      talk_angle: "Zapytaj o logistykę.", opening_questions: [],
    });
    const errs = groundingErrors(card, c, "palety");
    expect(errs.some((e) => e.includes("250"))).toBe(true);
    expect(errs.some((e) => e.includes("pkd"))).toBe(true);
    expect(errs.some((e) => e.includes("2015"))).toBe(false);
  });
  it("wyciąga JSON z tekstu", () => {
    expect(extractJson('Oto wynik: {"a":1}')).toEqual({ a: 1 });
  });
});
