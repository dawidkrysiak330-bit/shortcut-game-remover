// =============================================================
// CEIDG (Hurtownia danych CEIDG, API) — firmy jednoosobowe (JDG) = DANE OSOBOWE (RODO).
// Wymaga tokenu (wniosek przez biznes.gov.pl). Docs (ZWERYFIKUJ endpoint, wersję i parametry):
//   https://dane.biznes.gov.pl/
// NIE WIEM, czy aktualna wersja API pozwala filtrować po PKD + województwie i na jakich
// warunkach wolno to robić — dlatego w MVP adapter służy WYŁĄCZNIE do weryfikacji po NIP.
// Minimalizacja: nie zapisujemy imienia/nazwiska osobno, PESEL, adresu zamieszkania/korespondencyjnego,
// prywatnego telefonu ani e-maila.
// =============================================================
import type { RawCompany } from "../core/types.ts";
import type { AdapterContext, EnrichmentAdapter } from "./types.ts";
import { fetchWithTimeout, limiter, nowIso } from "./types.ts";

const BASE = Deno.env.get("CEIDG_API_URL") ?? "https://dane.biznes.gov.pl/api/ceidg/v2/firmy";
const rate = limiter(1000);

export const ceidg: EnrichmentAdapter = {
  id: "ceidg",
  supportsIndustryRegionSearch: false, // w MVP świadomie wyłączone — patrz komentarz wyżej
  async enrichByNip(nip: string, ctx: AdapterContext): Promise<RawCompany[]> {
    const token = Deno.env.get("CEIDG_API_TOKEN");
    if (!token) return []; // źródło opcjonalne
    const url = `${BASE}?nip=${nip}`;
    const res = await rate(() => fetchWithTimeout(url, { headers: { Authorization: `Bearer ${token}` } }));
    await ctx.meter.record("ceidg", "firma", 1);
    if (!res.ok) return [];
    const firma = (await res.json())?.firmy?.[0]; // kształt odpowiedzi — ZWERYFIKUJ w docs
    if (!firma) return [];
    const a = firma.adresDzialalnosci ?? {};
    return [{
      source: "ceidg",
      source_url: url,
      fetched_at: nowIso(),
      is_natural_person: true,
      fields: {
        nip, name: firma.nazwa, status: firma.status, registration_date: firma.dataRozpoczecia,
        legal_form: "osoba fizyczna prowadząca działalność gospodarczą",
        pkd: Array.isArray(firma.pkd) ? firma.pkd.map((p: { kod?: string } | string) => (typeof p === "string" ? p : p.kod)).filter(Boolean) : undefined,
        postal_code: a.kod, city: a.miasto, region: a.wojewodztwo,
        website: firma.www,
      },
    }];
  },
};
