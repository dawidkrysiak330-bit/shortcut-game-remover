// =============================================================
// API KRS (Ministerstwo Sprawiedliwości) — odpis aktualny po numerze KRS.
// Docs (ZWERYFIKUJ): https://prs.ms.gov.pl/krs/openApi
// Szukanie tylko po numerze KRS — brak wyszukiwania po PKD+regionie.
// MINIMALIZACJA: pomijamy dział 2 (zarząd, prokurenci = osoby fizyczne) i wspólników.
// =============================================================
import type { RawCompany } from "../core/types.ts";
import type { AdapterContext } from "./types.ts";
import { fetchWithTimeout, limiter, nowIso } from "./types.ts";

const rate = limiter(500);

export async function krsByNumber(krs: string, ctx: AdapterContext): Promise<RawCompany[]> {
  const num = krs.replace(/\D/g, "").padStart(10, "0");
  const url = `https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/${num}?rejestr=P&format=json`;
  const res = await rate(() => fetchWithTimeout(url));
  await ctx.meter.record("krs", "odpis", 1);
  if (!res.ok) return [];
  const odpis = (await res.json())?.odpis;
  if (!odpis) return [];
  const d1 = odpis.dane?.dzial1;
  const adr = d1?.siedzibaIAdres?.adres;
  const przedmiot = odpis.dane?.dzial3?.przedmiotDzialalnosci;
  const pkdList = [...(przedmiot?.przedmiotPrzewazajacejDzialalnosci ?? []), ...(przedmiot?.przedmiotPozostalejDzialalnosci ?? [])]
    // deno-lint-ignore no-explicit-any
    .map((p: any) => `${p.kodDzial}.${p.kodKlasa}.${p.kodPodklasa}`);
  // deno-lint-ignore no-explicit-any
  const opis = (przedmiot?.przedmiotPrzewazajacejDzialalnosci ?? []).map((p: any) => p.opis).join("; ");
  return [{
    source: "krs",
    source_url: url,
    fetched_at: nowIso(),
    fields: {
      krs: num,
      name: d1?.danePodmiotu?.nazwa,
      legal_form: d1?.danePodmiotu?.formaPrawna,
      status: odpis.naglowekA?.dataWykreslenia ? "wykreślony" : "aktywny",
      registration_date: odpis.naglowekA?.dataRejestracjiWKRS,
      postal_code: adr?.kodPocztowy,
      city: adr?.miejscowosc,
      region: d1?.siedzibaIAdres?.siedziba?.wojewodztwo,
      address: adr ? `${adr.ulica ?? ""} ${adr.nrDomu ?? ""}, ${adr.kodPocztowy ?? ""} ${adr.miejscowosc ?? ""}`.trim() : undefined,
      website: d1?.siedzibaIAdres?.adresStronyInternetowej,
      pkd: pkdList,
      description_text: opis || undefined,
    },
  }];
}
