import { describe, expect, it } from "vitest";
import { clusterRecords, dedupe } from "../../supabase/functions/_shared/core/dedup.ts";
import type { RawCompany } from "../../supabase/functions/_shared/core/types.ts";
import { fakeNip, mockRawRecords } from "../../src/lib/mockData.ts";

const T = "2026-11-20T10:00:00Z";
const rec = (source: RawCompany["source"], fields: RawCompany["fields"]): RawCompany => ({ source, fetched_at: T, fields });

describe("deduplikacja", () => {
  it("łączy po NIP", () => {
    const n = fakeNip(10);
    expect(clusterRecords([rec("gus_bir", { nip: n, name: "A" }), rec("biala_lista", { nip: `PL${n}`, name: "B" })])).toHaveLength(1);
  });
  it("łączy po domenie, potem po telefonie", () => {
    const r = [
      rec("google_places", { name: "Alfa", website: "https://www.alfa.pl", phone: "12 111 22 33" }),
      rec("website", { website: "http://alfa.pl/kontakt" }),
      rec("google_places", { name: "ALFA bis", phone: "+48 121112233" }),
    ];
    expect(clusterRecords(r)).toHaveLength(1);
  });
  it("łączy po nazwie + kodzie pocztowym (fuzzy)", () => {
    const r = [
      rec("google_places", { name: "Meble Kowalscy Sp. z o.o.", postal_code: "30-001" }),
      rec("gus_bir", { name: "MEBLE KOWALSCY SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ", postal_code: "30-001" }),
    ];
    expect(clusterRecords(r)).toHaveLength(1);
  });
  it("NIE łączy podobnych nazw z innych miejscowości", () => {
    const r = [rec("google_places", { name: "Meble Kowalscy", city: "Kraków" }), rec("google_places", { name: "Meble Kowalscy", city: "Tarnów" })];
    expect(clusterRecords(r)).toHaveLength(2);
  });
  it("NIE łączy rekordów z różnymi NIP-ami, nawet przy wspólnej domenie", () => {
    const r = [rec("gus_bir", { nip: fakeNip(1), website: "grupa.pl" }), rec("gus_bir", { nip: fakeNip(2), website: "grupa.pl" })];
    expect(clusterRecords(r)).toHaveLength(2);
  });
  it("każde pole po scaleniu ma źródło i datę pobrania", () => {
    const { raw, pages } = mockRawRecords(40);
    const merged = dedupe(raw, pages);
    for (const c of merged) for (const list of Object.values(c.fields)) for (const fv of list ?? []) {
      expect(fv.source).toBeTruthy();
      expect(fv.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });
  it("na danych testowych: 40 firm, duplikat z Places scalony", () => {
    const { raw, pages } = mockRawRecords(40);
    expect(dedupe(raw, pages)).toHaveLength(40);
  });
});
