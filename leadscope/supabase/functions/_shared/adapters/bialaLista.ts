// =============================================================
// Wykaz podatników VAT ("Biała lista"), API Ministerstwa Finansów.
// Docs (ZWERYFIKUJ endpointy i limity): https://wl-api.mf.gov.pl/
// Szukanie wyłącznie po NIP/REGON/rachunku — NIE da się szukać po PKD+regionie
// → używamy tylko do weryfikacji i wzbogacania.
// MINIMALIZACJA: odrzucamy numery rachunków, reprezentantów, prokurentów i wspólników
// (to dane osobowe / zbędne do celu).
// =============================================================
import type { RawCompany } from "../core/types.ts";
import type { AdapterContext, EnrichmentAdapter } from "./types.ts";
import { fetchWithTimeout, limiter, nowIso } from "./types.ts";

const BASE = "https://wl-api.mf.gov.pl/api/search/nip/";
const rate = limiter(1000);

function splitAddress(a?: string): { postal_code?: string; city?: string } {
  const m = a?.match(/(\d{2}-\d{3})\s+(.+)$/);
  return m ? { postal_code: m[1], city: m[2].trim() } : {};
}

export const bialaLista: EnrichmentAdapter = {
  id: "biala_lista",
  supportsIndustryRegionSearch: false,
  async enrichByNip(nip: string, ctx: AdapterContext): Promise<RawCompany[]> {
    const date = new Date().toISOString().slice(0, 10);
    const url = `${BASE}${nip}?date=${date}`;
    const res = await rate(() => fetchWithTimeout(url));
    await ctx.meter.record("biala_lista", "search", 1);
    if (!res.ok) return [];
    const subject = (await res.json())?.result?.subject;
    if (!subject) return [];
    const address = subject.workingAddress ?? subject.residenceAddress; // residenceAddress = adres JDG — tylko gdy brak adresu działalności
    return [{
      source: "biala_lista",
      source_url: url,
      fetched_at: nowIso(),
      fields: {
        nip: subject.nip, name: subject.name, regon: subject.regon, krs: subject.krs || undefined,
        vat_status: subject.statusVat, registration_date: subject.registrationLegalDate ?? undefined,
        address, ...splitAddress(address),
      },
    }];
  },
};
