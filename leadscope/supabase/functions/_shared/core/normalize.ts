// =============================================================
// Normalizacja i walidacja: NIP, telefon, domena, e-mail, nazwa.
// Czyste funkcje — łatwe do testowania.
// =============================================================

/** Usuwa polskie znaki diakrytyczne i zamienia na małe litery. */
export function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sprawdza sumę kontrolną NIP (10 cyfr, wagi 6,5,7,2,3,4,5,6,7). */
export function isValidNip(nip: string): boolean {
  const d = nip.replace(/\D/g, "");
  if (d.length !== 10) return false;
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = w.reduce((acc, wi, i) => acc + wi * Number(d[i]), 0);
  const check = sum % 11;
  return check !== 10 && check === Number(d[9]);
}

/** Zwraca NIP jako 10 cyfr albo null, jeśli niepoprawny. */
export function normalizeNip(nip: string | undefined | null): string | null {
  if (!nip) return null;
  const d = nip.replace(/^PL/i, "").replace(/\D/g, "");
  return isValidNip(d) ? d : null;
}

/** Wyszukuje poprawne NIP-y w tekście (np. "NIP: 123-456-32-18"). */
export function extractNips(text: string): string[] {
  const found = new Set<string>();
  const re = /NIP[\s:.\-]*((?:PL)?\s?\d{3}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}|\d{3}[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{3}|\d{10})/gi;
  for (const m of text.matchAll(re)) {
    const n = normalizeNip(m[1]);
    if (n) found.add(n);
  }
  return [...found];
}

/** Domeny, które nie identyfikują firmy (nie łączymy po nich rekordów). */
const NON_IDENTIFYING_DOMAINS = new Set([
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "google.com",
  "goo.gl",
  "youtube.com",
  "allegro.pl",
  "olx.pl",
  "panoramafirm.pl",
]);

/** "https://www.Firma.pl/kontakt" -> "firma.pl". Zwraca null dla portali społecznościowych. */
export function normalizeDomain(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!host.includes(".")) return null;
    if (NON_IDENTIFYING_DOMAINS.has(host)) return null;
    return host;
  } catch {
    return null;
  }
}

/** Normalizuje polski numer telefonu do formatu +48XXXXXXXXX. */
export function normalizePhone(phone: string | undefined | null): string | null {
  if (!phone) return null;
  let d = phone.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("48")) d = d.slice(2);
  if (d.length !== 9) return null;
  return `+48${d}`;
}

/** Prefiksy adresów rolowych (firmowych), nie imiennych — minimalizacja danych osobowych. */
const GENERIC_EMAIL_PREFIXES = [
  "biuro", "info", "kontakt", "contact", "office", "sekretariat", "sales", "sprzedaz",
  "handel", "zamowienia", "zakupy", "hello", "firma", "recepcja", "obsluga", "bok",
  "marketing", "export", "eksport", "serwis", "service", "support", "admin",
];

/** true tylko dla adresów rolowych typu biuro@firma.pl (nie jan.kowalski@firma.pl). */
export function isGenericEmail(email: string): boolean {
  const m = email.toLowerCase().match(/^([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/);
  if (!m) return false;
  const local = normText(m[1]);
  // dopuszczamy np. "biuro", "biuro2", "biuro.krakow" — ale nie "jan.kowalski"
  return GENERIC_EMAIL_PREFIXES.some((p) => new RegExp(`^${p}([._-]|\\d|$)`).test(local));
}

/** Wyszukuje adresy e-mail w tekście i zostawia tylko rolowe. */
export function extractGenericEmails(text: string): string[] {
  const all = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  return [...new Set(all.map((e) => e.toLowerCase()))].filter(isGenericEmail);
}

/** Wyszukuje numery telefonów PL w tekście. */
export function extractPhones(text: string): string[] {
  const all = text.match(/(?:\+48|0048)?[\s(]*\d{2,3}[\s)\-]*\d{3}[\s-]*\d{2,3}[\s-]*\d{2,3}/g) ?? [];
  return [...new Set(all.map(normalizePhone).filter((p): p is string => !!p))];
}

const LEGAL_FORM_TOKENS = [
  "spolka z ograniczona odpowiedzialnoscia", "spolka akcyjna", "spolka komandytowa",
  "spolka jawna", "spolka cywilna", "sp z o o", "sp zoo", "sp k", "sp j", "s c", "s a",
  "spolka", "sp", "p h u", "phu", "fhu", "f h u", "ppuh",
];

/** Nazwa bez formy prawnej i interpunkcji — do porównań fuzzy. */
export function normalizeName(name: string): string {
  let n = " " + normText(name).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ") + " ";
  for (const t of LEGAL_FORM_TOKENS) n = n.replaceAll(` ${t} `, " ");
  return n.replace(/\s+/g, " ").trim();
}

/** Podobieństwo tekstów 0–1 (współczynnik Dice na bigramach). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [g, c] of A) inter += Math.min(c, B.get(g) ?? 0);
  return (2 * inter) / (a.length - 1 + (b.length - 1));
}

/** Kod PKD bez kropek, np. "25.62.Z" -> "2562Z". */
export function normalizePkd(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** Odległość w km między dwoma punktami (wzór haversine). */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
