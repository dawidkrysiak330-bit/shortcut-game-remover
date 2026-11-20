import { describe, expect, it } from "vitest";
import { buildCard, buildDescription, contentSentences } from "../../supabase/functions/_shared/core/card.ts";
import { groundingErrors, NO_DESCRIPTION, LeadCardLlmSchema } from "../../supabase/functions/_shared/core/schemas.ts";
import { buildLeads } from "../../supabase/functions/_shared/core/pipeline.ts";
import { mergeCluster } from "../../supabase/functions/_shared/core/dedup.ts";
import { DEFAULT_WEIGHTS } from "../../supabase/functions/_shared/core/types.ts";
import { MOCK_ICP, mockRawRecords } from "../../src/lib/mockData.ts";

const T = "2026-11-20T10:00:00Z";

describe("karta leada bez AI (reguły)", () => {
  const { raw, pages } = mockRawRecords(40);
  const leads = buildLeads(raw, pages, MOCK_ICP, { country: "PL", region_name: "małopolskie" }, DEFAULT_WEIGHTS);

  it("każda karta przechodzi schemat i kontrolę ugruntowania (0 faktów spoza danych)", () => {
    for (const l of leads) {
      const card = buildCard(l.company, l.score, MOCK_ICP.product);
      expect(LeadCardLlmSchema.safeParse(card).success).toBe(true);
      expect(groundingErrors(card, l.company, MOCK_ICP.product)).toEqual([]);
    }
  });

  it("opis: KRS ma pierwszeństwo, potem dosłowne zdania z www, inaczej BRAK", () => {
    const krs = mergeCluster([{ source: "krs", fetched_at: T, fields: { description_text: "Produkcja mebli biurowych" } }]);
    expect(buildDescription(krs)).toContain("Produkcja mebli biurowych");
    const www = mergeCluster([{ source: "website", fetched_at: T, fields: {} }], [
      { url: "https://a.example/o-nas", fetched_at: T, text: "Menu Oferta Kontakt\nJesteśmy rodzinną firmą produkującą meble kuchenne na wymiar od lat." },
    ]);
    expect(buildDescription(www)).toContain("Jesteśmy rodzinną firmą");
    expect(buildDescription(www)).not.toContain("Menu");
    expect(buildDescription(mergeCluster([{ source: "google_places", fetched_at: T, fields: { name: "X" } }]))).toBe(NO_DESCRIPTION);
  });

  it("odrzuca zdania z menu, cookies i e-mailami", () => {
    expect(contentSentences("Strona główna\nUżywamy cookies, aby strona działała lepiej dla Ciebie.\nPiszcie na biuro@a.pl w każdej sprawie handlowej.")).toEqual([]);
  });
});
