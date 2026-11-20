// =============================================================
// Google Places API (New) — Text Search. TYLKO oficjalne API, bez scrapowania Map.
// Dokumentacja (ZWERYFIKUJ przed produkcją — sieć tego środowiska nie pozwoliła pobrać docs):
//   https://developers.google.com/maps/documentation/places/web-service/text-search
// Uwaga kosztowa: SKU (cena) zależy od pól w X-Goog-FieldMask. websiteUri/telefon
// podnoszą SKU — sprawdź cennik i ustaw ceny w tabeli source_pricing.
// Przechowywanie: trwale tylko place_id; reszta treści wygasa (patrz COMPLIANCE.md).
// =============================================================
import type { RawCompany } from "../core/types.ts";
import type { AdapterContext, DiscoveryAdapter, SearchParams } from "./types.ts";
import { fetchWithTimeout, limiter, nowIso } from "./types.ts";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK = [
  "places.id", "places.displayName", "places.formattedAddress", "places.addressComponents", "places.location",
  "places.websiteUri", "places.nationalPhoneNumber", "places.businessStatus", "places.types", "places.googleMapsUri",
  "nextPageToken",
].join(",");
const MAX_PAGES_PER_QUERY = 3; // 3 × 20 = 60 wyników na zapytanie (limit API — zweryfikuj)
const MAX_QUERIES = 8;
const rate = limiter(200);

function key(): string {
  const k = Deno.env.get("GOOGLE_PLACES_API_KEY");
  if (!k) throw new Error("Brak sekretu GOOGLE_PLACES_API_KEY");
  return k;
}

interface PlacesState { qi: number; pageToken?: string; page: number }

// deno-lint-ignore no-explicit-any
export function placeToRaw(p: any, fetched_at: string): RawCompany {
  // deno-lint-ignore no-explicit-any
  const comp = (type: string) => p.addressComponents?.find((c: any) => c.types?.includes(type))?.longText as string | undefined;
  return {
    source: "google_places",
    source_url: p.googleMapsUri,
    fetched_at,
    fields: {
      place_id: p.id,
      name: p.displayName?.text,
      address: p.formattedAddress,
      postal_code: comp("postal_code"),
      city: comp("locality") ?? comp("postal_town"),
      region: comp("administrative_area_level_1"),
      lat: p.location?.latitude !== undefined ? String(p.location.latitude) : undefined,
      lng: p.location?.longitude !== undefined ? String(p.location.longitude) : undefined,
      website: p.websiteUri,
      phone: p.nationalPhoneNumber,
      business_status: p.businessStatus,
      types: p.types,
    },
  };
}

export function buildQueries(p: SearchParams): string[] {
  const where = p.center ? "" : ` województwo ${p.region.name}`;
  return p.icp.keywords.slice(0, MAX_QUERIES).map((k) => `${k}${where}`);
}

export const googlePlaces: DiscoveryAdapter = {
  id: "google_places",
  /** Jedno wywołanie = jedna strona wyników; stan pozwala kontynuować w kolejnym "ticku". */
  async search(p: SearchParams, ctx: AdapterContext, rawState: unknown) {
    const state = (rawState as PlacesState) ?? { qi: 0, page: 0 };
    const queries = buildQueries(p);
    if (state.qi >= queries.length) return { records: [], state, done: true };
    const center = p.center ?? { lat: p.region.capital.lat, lng: p.region.capital.lng };
    const radiusM = Math.min((p.radius_km ?? 50) * 1000, 50_000); // locationBias circle: max 50 km
    const body: Record<string, unknown> = {
      textQuery: queries[state.qi],
      languageCode: "pl",
      regionCode: p.country,
      pageSize: 20,
      locationBias: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: radiusM } },
    };
    if (state.pageToken) body.pageToken = state.pageToken;
    const res = await rate(() => fetchWithTimeout(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key(), "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify(body),
    }));
    await ctx.meter.record("google_places", "text_search_enterprise", 1);
    if (!res.ok) throw new Error(`Google Places ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const t = nowIso();
    const records = (data.places ?? []).map((pl: unknown) => placeToRaw(pl, t));
    const next: PlacesState = data.nextPageToken && state.page + 1 < MAX_PAGES_PER_QUERY
      ? { qi: state.qi, pageToken: data.nextPageToken, page: state.page + 1 }
      : { qi: state.qi + 1, page: 0 };
    return { records, state: next, done: next.qi >= queries.length };
  },
};

/** Odświeżenie danych miejsca po place_id (zamiast trzymania treści w bazie). */
export async function getPlace(placeId: string, ctx: AdapterContext): Promise<RawCompany | null> {
  const mask = FIELD_MASK.split(",").filter((f) => f.startsWith("places.")).map((f) => f.slice(7)).join(",");
  const res = await rate(() => fetchWithTimeout(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { "X-Goog-Api-Key": key(), "X-Goog-FieldMask": mask },
  }));
  await ctx.meter.record("google_places", "place_details_enterprise", 1);
  if (!res.ok) return null;
  return placeToRaw(await res.json(), nowIso());
}

/** Geokodowanie miasta (środek promienia) przez Text Search. */
export async function geocodeCity(city: string, country: string, ctx: AdapterContext): Promise<{ lat: number; lng: number } | null> {
  const res = await rate(() => fetchWithTimeout(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key(), "X-Goog-FieldMask": "places.location" },
    body: JSON.stringify({ textQuery: city, regionCode: country, languageCode: "pl", pageSize: 1 }),
  }));
  await ctx.meter.record("google_places", "text_search_location_only", 1);
  if (!res.ok) return null;
  const loc = (await res.json()).places?.[0]?.location;
  return loc ? { lat: loc.latitude, lng: loc.longitude } : null;
}
