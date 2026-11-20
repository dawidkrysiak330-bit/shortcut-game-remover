// =============================================================
// Dane TESTOWE (fikcyjne firmy) dla trybu demo i testów E2E.
// Nazwy, NIP-y (z poprawną sumą kontrolną) i domeny (.example) są zmyślone.
// Generujemy rekordy tak, jakby przyszły z różnych źródeł —
// w tym duplikaty, konkurenta i firmę wykreśloną — żeby przetestować
// prawdziwą deduplikację i scoring.
// =============================================================
import type { Icp, RawCompany, WebsitePage } from "../../supabase/functions/_shared/core/types.ts";

export const MOCK_ICP: Icp = {
  product: "palety drewniane EPAL",
  buyer_industries: ["producent mebli", "logistyka", "magazyn", "producent wyrobów metalowych"],
  pkd_codes: ["31.09.Z", "52.10.B", "25.62.Z", "49.41.Z"],
  nace_codes: ["31.09", "52.10", "25.62", "49.41"],
  keywords: ["producent mebli", "magazyn logistyczny", "obróbka metali", "transport drogowy"],
  buying_signals: ["wysyłka paletowa", "magazyn wysokiego składowania", "eksport", "produkcja seryjna"],
  exclusion_signals: ["produkcja palet", "skup palet"],
  target_scale: ["small", "medium", "large"],
};

/** Generuje fikcyjny, ale poprawny (suma kontrolna) NIP. */
export function fakeNip(seed: number): string {
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  for (let s = seed; ; s++) {
    const base = String(100000000 + ((s * 7919) % 899999999)).slice(0, 9);
    const sum = w.reduce((a, wi, i) => a + wi * Number(base[i]), 0) % 11;
    if (sum !== 10) return base + String(sum);
  }
}

const T = "2026-11-20T10:00:00.000Z";
const KINDS = [
  { name: "Meble", pkd: "31.09.Z", type: "furniture_store", signal: "produkcja seryjna i wysyłka paletowa do klientów", form: "spółka z ograniczoną odpowiedzialnością" },
  { name: "Logistyka", pkd: "52.10.B", type: "storage", signal: "magazyn wysokiego składowania, eksport do UE", form: "spółka akcyjna" },
  { name: "Metal", pkd: "25.62.Z", type: "point_of_interest", signal: "obróbka CNC, produkcja seryjna", form: "spółka komandytowa" },
  { name: "Trans", pkd: "49.41.Z", type: "moving_company", signal: "transport drogowy, wysyłka paletowa", form: "spółka z ograniczoną odpowiedzialnością" },
  { name: "Piekarnia", pkd: "10.71.Z", type: "bakery", signal: "pieczywo codziennie świeże", form: "osoba fizyczna prowadząca działalność gospodarczą" },
];
const CITIES = [
  { city: "Kraków", postal: "30-001", lat: 50.06, lng: 19.94 },
  { city: "Tarnów", postal: "33-100", lat: 50.01, lng: 20.98 },
  { city: "Nowy Sącz", postal: "33-300", lat: 49.62, lng: 20.69 },
  { city: "Oświęcim", postal: "32-600", lat: 50.03, lng: 19.21 },
];

export function mockRawRecords(count = 40): { raw: RawCompany[]; pages: Record<string, WebsitePage[]> } {
  const raw: RawCompany[] = [];
  const pages: Record<string, WebsitePage[]> = {};
  for (let i = 1; i <= count; i++) {
    const k = KINDS[i % KINDS.length];
    const c = CITIES[i % CITIES.length];
    const nr = String(i).padStart(2, "0");
    const name = `${k.name} Testowa ${nr}`;
    const domain = `${k.name.toLowerCase()}-testowa-${nr}.example`;
    const website = `https://www.${domain}/`;
    const phone = `12 ${String(300 + i).padStart(3, "0")} ${String(10 + i).padStart(2, "0")} ${String(20 + i).padStart(2, "0")}`;
    const nip = fakeNip(i);
    const hasWebsite = i % 7 !== 0;
    // 1) Google Places
    raw.push({
      source: "google_places", fetched_at: T, source_url: `https://maps.google.com/?cid=mock${i}`,
      fields: {
        name: `${name} Sp. z o.o.`, place_id: `mock_place_${i}`, address: `ul. Testowa ${i}, ${c.postal} ${c.city}`,
        postal_code: c.postal, city: c.city, region: "Województwo małopolskie", lat: String(c.lat), lng: String(c.lng),
        website: hasWebsite ? website : undefined, phone, business_status: "OPERATIONAL", types: [k.type],
      },
    });
    // 2) strona www (NIP + e-mail rolowy)
    if (hasWebsite) {
      const competitor = i === 3; // konkurent → wykluczenie
      pages[domain] = [{
        url: website, fetched_at: T,
        text: `${name}. ${competitor ? "Zajmujemy się produkcja palet i skup palet." : k.signal}. Kontakt: biuro@${domain}, tel. ${phone}. NIP: ${nip}`,
      }];
      raw.push({ source: "website", fetched_at: T, source_url: website, fields: { website, nip, email: `biuro@${domain}`, phone } });
    }
    // 3) Biała lista VAT + GUS (po NIP) — tylko dla firm z www (bo NIP znamy ze strony)
    if (hasWebsite) {
      const struck = i === 5; // firma wykreślona → wykluczenie
      raw.push({
        source: "biala_lista", fetched_at: T, source_url: `https://wl-api.mf.gov.pl/api/search/nip/${nip}`,
        fields: { nip, name: `${name.toUpperCase()} SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ`, vat_status: struck ? "Niezarejestrowany" : "Czynny", postal_code: c.postal, city: c.city },
      });
      raw.push({
        source: "gus_bir", fetched_at: T, source_url: "https://wyszukiwarkaregon.stat.gov.pl",
        is_natural_person: k.form.startsWith("osoba fizyczna"),
        fields: {
          nip, regon: String(100000000 + i), name: `${name} Sp. z o.o.`, legal_form: k.form, pkd: [k.pkd],
          status: struck ? "wykreślony" : "aktywny", postal_code: c.postal, city: c.city, region: "MAŁOPOLSKIE",
          registration_date: `20${String(10 + (i % 14)).padStart(2, "0")}-03-01`, phone,
        },
      });
    }
  }
  // Duplikat z innego zapytania Places (ta sama firma, inny zapis nazwy) — dedup po telefonie
  raw.push({
    source: "google_places", fetched_at: T, fields: {
      name: "MEBLE TESTOWA 05", place_id: "mock_place_dup", postal_code: CITIES[1].postal, city: CITIES[1].city,
      region: "Województwo małopolskie", phone: `12 305 15 25`,
    },
  });
  return { raw, pages };
}
