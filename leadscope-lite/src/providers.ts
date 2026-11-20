// =============================================================
// Dostawcy danych: Google Places API (oficjalne API — BEZ scrapowania Map),
// pobieranie stron www i Biała lista VAT.
// Tryb LITE_MOCK=1 podmienia sieć na dane fikcyjne (do testów i demo bez klucza).
// =============================================================

export interface Place {
  place_id: string;
  name?: string;
  address?: string;
  region?: string;
  lat?: number;
  lng?: number;
  website?: string;
  phone?: string;
  rating?: number;
  business_status?: string;
  maps_url: string;
}

export interface Providers {
  /** Jedna strona wyników Text Search (max 20). */
  placesSearch(query: string, center: { lat: number; lng: number }, radiusM: number, pageToken?: string): Promise<{ places: Place[]; nextPageToken?: string }>;
  geocode(text: string): Promise<{ lat: number; lng: number } | null>;
  fetchText(url: string, userAgent: string): Promise<{ status: number; contentType: string; body: string }>;
  bialaLista(nip: string): Promise<{ name?: string; address?: string; statusVat?: string; regon?: string; krs?: string; url: string } | null>;
}

const MAX_BYTES = 600_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 10_000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}

// ---------------------------------------------------------------- prawdziwe API

// Pola, o które prosimy Google. Od nich zależy cena (SKU) — ZWERYFIKUJ cennik:
// https://developers.google.com/maps/billing-and-pricing/pricing
const FIELD_MASK = [
  "places.id", "places.displayName", "places.formattedAddress", "places.addressComponents", "places.location",
  "places.websiteUri", "places.nationalPhoneNumber", "places.rating", "places.businessStatus", "nextPageToken",
].join(",");

/** Oficjalny format linku do miejsca po place_id. */
export const mapsUrl = (placeId: string) => `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;

export function realProviders(apiKey: string): Providers {
  const headers = (mask: string) => ({ "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": mask });
  return {
    async placesSearch(query, center, radiusM, pageToken) {
      const body: Record<string, unknown> = {
        textQuery: query, languageCode: "pl", regionCode: "PL", pageSize: 20,
        locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: Math.min(radiusM, 50_000) } },
      };
      if (pageToken) body.pageToken = pageToken;
      const res = await fetchWithTimeout("https://places.googleapis.com/v1/places:searchText", { method: "POST", headers: headers(FIELD_MASK), body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Google Places ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      // deno-lint-ignore no-explicit-any
      const places: Place[] = (data.places ?? []).map((p: any) => ({
        place_id: p.id,
        name: p.displayName?.text,
        address: p.formattedAddress,
        // deno-lint-ignore no-explicit-any
        region: p.addressComponents?.find((c: any) => c.types?.includes("administrative_area_level_1"))?.longText,
        lat: p.location?.latitude, lng: p.location?.longitude,
        website: p.websiteUri, phone: p.nationalPhoneNumber, rating: p.rating, business_status: p.businessStatus,
        maps_url: mapsUrl(p.id),
      }));
      return { places, nextPageToken: data.nextPageToken };
    },
    async geocode(text) {
      const res = await fetchWithTimeout("https://places.googleapis.com/v1/places:searchText", {
        method: "POST", headers: headers("places.location"), body: JSON.stringify({ textQuery: text, regionCode: "PL", pageSize: 1 }),
      });
      if (!res.ok) return null;
      const loc = (await res.json()).places?.[0]?.location;
      return loc ? { lat: loc.latitude, lng: loc.longitude } : null;
    },
    async fetchText(url, userAgent) {
      const res = await fetchWithTimeout(url, { headers: { "User-Agent": userAgent, Accept: "text/html,text/plain" }, redirect: "follow" });
      const body = (await res.text()).slice(0, MAX_BYTES);
      return { status: res.status, contentType: res.headers.get("content-type") ?? "", body };
    },
    async bialaLista(nip) {
      // ZWERYFIKUJ endpoint i dzienne limity: https://wl-api.mf.gov.pl/
      const url = `https://wl-api.mf.gov.pl/api/search/nip/${nip}?date=${new Date().toISOString().slice(0, 10)}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) return null;
      const s = (await res.json())?.result?.subject;
      if (!s) return null;
      // Celowo pomijamy rachunki bankowe, reprezentantów i wspólników (dane zbędne / osobowe).
      return { name: s.name, address: s.workingAddress ?? s.residenceAddress, statusVat: s.statusVat, regon: s.regon, krs: s.krs, url };
    },
  };
}

// ---------------------------------------------------------------- dane fikcyjne (LITE_MOCK=1)

function fakeNip(seed: number): string {
  const w = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  for (let s = seed; ; s++) {
    const base = String(100000000 + ((s * 7919) % 899999999)).slice(0, 9);
    const sum = w.reduce((a, wi, i) => a + wi * Number(base[i]), 0) % 11;
    if (sum !== 10) return base + String(sum);
  }
}

export function mockProviders(): Providers {
  const all = (query: string): Place[] => Array.from({ length: 45 }, (_, i) => {
    const n = i + 1;
    // te same firmy wracają dla różnych fraz (test deduplikacji): id zależy tylko od numeru
    const label = query.split(" ")[0];
    return {
      place_id: `mock_${n}`,
      name: `Firma Testowa ${n} (${label})`,
      address: `ul. Testowa ${n}, 30-0${String(n).padStart(2, "0")} Kraków`,
      region: n % 15 === 0 ? "Śląskie" : "Małopolskie",
      lat: 50.06, lng: 19.94,
      website: n % 6 === 0 ? undefined : `https://firma-${n}.example/`,
      phone: `12 ${300 + n} 10 ${10 + n}`,
      rating: 4.2,
      business_status: "OPERATIONAL",
      maps_url: mapsUrl(`mock_${n}`),
    };
  });
  return {
    async placesSearch(query, _c, _r, pageToken) {
      const page = pageToken ? Number(pageToken) : 0;
      const list = all(query).slice(page * 20, page * 20 + 20);
      return { places: list, nextPageToken: page < 2 && list.length === 20 ? String(page + 1) : undefined };
    },
    geocode: async () => ({ lat: 50.06, lng: 19.94 }),
    async fetchText(url) {
      const u = new URL(url);
      const n = Number(u.hostname.match(/firma-(\d+)/)?.[1] ?? 0);
      if (u.pathname === "/robots.txt") return { status: 200, contentType: "text/plain", body: n === 5 ? "User-agent: *\nDisallow: /" : "User-agent: *\nDisallow: /admin" };
      if (n === 7) return { status: 403, contentType: "text/html", body: "" }; // blokada → nie obchodzimy
      const html = u.pathname === "/"
        ? `<html><body><h1>Firma Testowa ${n}</h1><p>Produkcja i wysyłka paletowa.</p><a href="/kontakt">Kontakt</a><a href="/o-nas">O nas</a></body></html>`
        : `<html><body><p>Kontakt: biuro@firma-${n}.example, jan.kowalski@firma-${n}.example, tel. 12 ${300 + n} 10 ${10 + n}. NIP: ${fakeNip(n)}</p></body></html>`;
      return { status: 200, contentType: "text/html; charset=utf-8", body: html };
    },
    async bialaLista(nip) {
      return { name: `FIRMA TESTOWA SP. Z O.O. (NIP ${nip})`, address: "UL. TESTOWA 1, 30-001 KRAKÓW", statusVat: "Czynny", regon: "123456789", url: `https://wl-api.mf.gov.pl/api/search/nip/${nip}` };
    },
  };
}
