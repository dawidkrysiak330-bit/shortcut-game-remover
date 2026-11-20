// =============================================================
// GUS BIR 1.1 (REGON) — usługa SOAP. Wymaga klucza (bezpłatny, wniosek do GUS).
// Docs (ZWERYFIKUJ akcje SOAP i nazwy raportów w aktualnej dokumentacji BIR1.1):
//   https://api.stat.gov.pl/Home/RegonApi
// Szukanie TYLKO po NIP/REGON/KRS — brak wyszukiwania po PKD+regionie (nie obchodzimy tego).
// Środowisko testowe: ustaw GUS_BIR_ENV=test (publiczny klucz testowy z dokumentacji GUS).
// =============================================================
import type { RawCompany } from "../core/types.ts";
import { isGenericEmail } from "../core/normalize.ts";
import type { AdapterContext, EnrichmentAdapter } from "./types.ts";
import { fetchWithTimeout, limiter, nowIso } from "./types.ts";

const URL_PROD = "https://wyszukiwarkaregon.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc";
const URL_TEST = "https://wyszukiwarkaregontest.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc";
const NS = "http://CIS/BIR/PUBL/2014/07";
const rate = limiter(500);
let sid: string | null = null;

const endpoint = () => (Deno.env.get("GUS_BIR_ENV") === "test" ? URL_TEST : URL_PROD);

async function soap(action: string, body: string, withSid = true): Promise<string> {
  const env = `<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:ns="${NS}" xmlns:dat="${NS}/DataContract">
<soap:Header xmlns:wsa="http://www.w3.org/2005/08/addressing"><wsa:To>${endpoint()}</wsa:To><wsa:Action>${NS}/IUslugaBIRzewnPubl/${action}</wsa:Action></soap:Header>
<soap:Body>${body}</soap:Body></soap:Envelope>`;
  const headers: Record<string, string> = { "Content-Type": "application/soap+xml; charset=utf-8" };
  if (withSid && sid) headers["sid"] = sid;
  const res = await rate(() => fetchWithTimeout(endpoint(), { method: "POST", headers, body: env }, 15_000));
  return await res.text();
}

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() || undefined;

async function login(): Promise<void> {
  const key = Deno.env.get("GUS_BIR_KEY");
  if (!key) throw new Error("Brak sekretu GUS_BIR_KEY");
  const xml = await soap("Zaloguj", `<ns:Zaloguj><ns:pKluczUzytkownika>${key}</ns:pKluczUzytkownika></ns:Zaloguj>`, false);
  sid = tag(xml, "ZalogujResult") ?? null;
  if (!sid) throw new Error("GUS BIR: logowanie nieudane");
}

async function report(regon: string, name: string): Promise<string> {
  const xml = await soap("DanePobierzPelnyRaport",
    `<ns:DanePobierzPelnyRaport><ns:pRegon>${regon}</ns:pRegon><ns:pNazwaRaportu>${name}</ns:pNazwaRaportu></ns:DanePobierzPelnyRaport>`);
  return unescapeXml(tag(xml, "DanePobierzPelnyRaportResult") ?? "");
}

export const gusBir: EnrichmentAdapter = {
  id: "gus_bir",
  supportsIndustryRegionSearch: false,
  async enrichByNip(nip: string, ctx: AdapterContext): Promise<RawCompany[]> {
    if (!sid) await login();
    const xml = await soap("DaneSzukajPodmioty",
      `<ns:DaneSzukajPodmioty><ns:pParametryWyszukiwania><dat:Nip>${nip}</dat:Nip></ns:pParametryWyszukiwania></ns:DaneSzukajPodmioty>`);
    await ctx.meter.record("gus_bir", "report", 1);
    const data = unescapeXml(tag(xml, "DaneSzukajPodmiotyResult") ?? "");
    const regon = tag(data, "Regon");
    if (!regon) return [];
    const typ = tag(data, "Typ"); // P = prawna, F = fizyczna (JDG)
    const isPerson = typ === "F";
    const base: RawCompany = {
      source: "gus_bir",
      source_url: "https://wyszukiwarkaregon.stat.gov.pl",
      fetched_at: nowIso(),
      is_natural_person: isPerson,
      fields: {
        nip, regon, name: tag(data, "Nazwa"),
        region: tag(data, "Wojewodztwo"), city: tag(data, "Miejscowosc"), postal_code: tag(data, "KodPocztowy"),
        address: [tag(data, "Ulica"), tag(data, "NrNieruchomosci")].filter(Boolean).join(" ") || undefined,
        status: tag(data, "DataZakonczeniaDzialalnosci") ? "zakończona działalność" : "aktywny",
      },
    };
    if (!isPerson) {
      // Raport pełny osoby prawnej + PKD (nazwy raportów — zweryfikuj w docs BIR1.1)
      const full = await report(regon, "BIR11OsPrawna");
      const pkd = await report(regon, "BIR11OsPrawnaPkd");
      await ctx.meter.record("gus_bir", "report", 2);
      const email = tag(full, "praw_adresEmail");
      Object.assign(base.fields, {
        legal_form: tag(full, "praw_szczegolnaFormaPrawna_Nazwa") ?? tag(full, "praw_podstawowaFormaPrawna_Nazwa"),
        registration_date: tag(full, "praw_dataPowstania"),
        krs: tag(full, "praw_numerWRejestrzeEwidencji"),
        website: tag(full, "praw_adresStronyinternetowej"),
        phone: tag(full, "praw_numerTelefonu"),
        email: email && isGenericEmail(email) ? email : undefined, // tylko adres rolowy
        pkd: [...pkd.matchAll(/<praw_pkdKod>(\d{2})(\d{2})([A-Z])<\/praw_pkdKod>/g)].map((m) => `${m[1]}.${m[2]}.${m[3]}`),
      });
    } else {
      // JDG: NIE pobieramy telefonu/e-maila z rejestru (mogą być prywatne) — tylko forma prawna.
      base.fields.legal_form = "osoba fizyczna prowadząca działalność gospodarczą";
    }
    return [base];
  },
};
