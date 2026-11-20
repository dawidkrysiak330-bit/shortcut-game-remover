import { describe, expect, it } from "vitest";
import { scoreCompany, validateWeights, confirmedFields } from "../../supabase/functions/_shared/core/scoring.ts";
import { mergeCluster } from "../../supabase/functions/_shared/core/dedup.ts";
import { buildLeads, applyFilters } from "../../supabase/functions/_shared/core/pipeline.ts";
import { DEFAULT_WEIGHTS, type RawCompany, type SearchContext } from "../../supabase/functions/_shared/core/types.ts";
import { MOCK_ICP, fakeNip, mockRawRecords } from "../../src/lib/mockData.ts";

const T = "2026-11-20T10:00:00Z";
const ctx: SearchContext = { country: "PL", region_name: "małopolskie" };
const nip = fakeNip(3);
const good: RawCompany[] = [
  { source: "google_places", fetched_at: T, fields: { name: "Meble Alfa", region: "Województwo małopolskie", phone: "12 111 22 33", business_status: "OPERATIONAL", website: "https://alfa.example", postal_code: "30-001" } },
  { source: "gus_bir", fetched_at: T, fields: { nip, name: "Meble Alfa sp. z o.o.", pkd: ["31.09.Z"], legal_form: "spółka z ograniczoną odpowiedzialnością", status: "aktywny", postal_code: "30-001", phone: "121112233" } },
  { source: "website", fetched_at: T, fields: { website: "https://alfa.example", email: "biuro@alfa.example", nip } },
];
const pages = [{ url: "https://alfa.example/", fetched_at: T, text: "Produkcja seryjna mebli, wysyłka paletowa w całej Europie." }];

describe("scoring", () => {
  it("domyślne wagi sumują się do 100", () => expect(validateWeights(DEFAULT_WEIGHTS)).toBe(true));

  it("idealny lead dostaje 100% i rozbicie na składowe", () => {
    const s = scoreCompany(mergeCluster(good, pages), MOCK_ICP, ctx, DEFAULT_WEIGHTS);
    expect(s.total).toBe(100);
    expect(s.components.industry.points).toBe(30);
    expect(s.components.buying_signals.evidence.length).toBeGreaterThan(0);
    expect(s.justification.length).toBeGreaterThan(10);
  });

  it("brak www → 0 pkt za sygnały i flaga BRAK DANYCH", () => {
    const s = scoreCompany(mergeCluster(good, []), MOCK_ICP, ctx, DEFAULT_WEIGHTS);
    expect(s.components.buying_signals.points).toBe(0);
    expect(s.components.buying_signals.flags).toContain("BRAK DANYCH");
  });

  it("PKD z tej samej klasy (4 cyfry) → 80% punktów za branżę", () => {
    const r = structuredClone(good); r[1].fields.pkd = ["31.09.A"];
    expect(scoreCompany(mergeCluster(r, pages), MOCK_ICP, ctx, DEFAULT_WEIGHTS).components.industry.points).toBe(24);
  });

  it("firma wykreślona → 0% z powodem", () => {
    const r = structuredClone(good); r[1].fields.status = "wykreślony";
    const s = scoreCompany(mergeCluster(r, pages), MOCK_ICP, ctx, DEFAULT_WEIGHTS);
    expect(s.total).toBe(0); expect(s.excluded).toBe(true); expect(s.exclusion_reason).toMatch(/wykreślony/);
  });

  it("konkurent (sygnał wykluczający na www) → 0%", () => {
    const s = scoreCompany(mergeCluster(good, [{ ...pages[0], text: "Nasza specjalność: produkcja palet." }]), MOCK_ICP, ctx, DEFAULT_WEIGHTS);
    expect(s.total).toBe(0); expect(s.exclusion_reason).toMatch(/produkcja palet/);
  });

  it("wagi z konfiguracji są respektowane", () => {
    const w = { ...DEFAULT_WEIGHTS, industry: 50, buying_signals: 5 };
    const s = scoreCompany(mergeCluster(good, pages), MOCK_ICP, ctx, w);
    expect(s.components.industry.max).toBe(50);
    expect(s.components.buying_signals.max).toBe(5);
  });

  it("pewność danych: pola potwierdzone w ≥2 źródłach", () => {
    const c = mergeCluster(good, pages);
    expect(confirmedFields(c)).toEqual(expect.arrayContaining(["name", "nip", "phone", "website", "postal_code"]));
    expect(scoreCompany(c, MOCK_ICP, ctx, DEFAULT_WEIGHTS).confidence).toBe("Wysoka");
    expect(scoreCompany(mergeCluster([good[0]], []), MOCK_ICP, ctx, DEFAULT_WEIGHTS).confidence).toBe("Niska");
  });

  it("promień: firma dalej niż promień dostaje mniej za lokalizację", () => {
    const near = structuredClone(good); near[0].fields.lat = "50.06"; near[0].fields.lng = "19.94";
    const far = structuredClone(good); far[0].fields.lat = "49.3"; far[0].fields.lng = "19.95";
    const rctx = { ...ctx, center: { lat: 50.06, lng: 19.94 }, radius_km: 30 };
    const a = scoreCompany(mergeCluster(near, pages), MOCK_ICP, rctx, DEFAULT_WEIGHTS).components.location.points;
    const b = scoreCompany(mergeCluster(far, pages), MOCK_ICP, rctx, DEFAULT_WEIGHTS).components.location.points;
    expect(a).toBeGreaterThan(b);
  });
});

describe("pipeline na mockach", () => {
  const { raw, pages: p } = mockRawRecords(40);
  const leads = buildLeads(raw, p, MOCK_ICP, ctx, DEFAULT_WEIGHTS);
  it("zwraca ≥30 unikalnych firm posortowanych po score", () => {
    expect(leads.length).toBeGreaterThanOrEqual(30);
    for (let i = 1; i < leads.length; i++) expect(leads[i - 1].score.total).toBeGreaterThanOrEqual(leads[i].score.total);
  });
  it("wyklucza konkurenta i firmę wykreśloną", () => {
    expect(leads.filter((l) => l.score.excluded).map((l) => l.company.fields.name?.[0].value)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Trans Testowa 03/), expect.stringMatching(/Meble Testowa 05/)]),
    );
  });
  it("filtry: min. score, tylko z www, PKD", () => {
    expect(applyFilters(leads, { min_score: 60 }).every((l) => l.score.total >= 60)).toBe(true);
    expect(applyFilters(leads, { only_with_website: true }).every((l) => l.company.fields.website?.length)).toBe(true);
    expect(applyFilters(leads, { pkd: "31" }).length).toBeGreaterThan(0);
  });
});
