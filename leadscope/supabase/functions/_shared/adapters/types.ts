// Interfejs adaptera źródła. Każde źródło = osobny plik w tym katalogu.
// Nowe źródło dodawaj TYLKO, gdy jego regulamin na to pozwala (opisz je w SOURCES.md).
import type { Icp, RawCompany } from "../core/types.ts";
import type { Region } from "../core/regions.ts";
import type { CostMeter } from "../costs.ts";

export interface AdapterContext {
  meter: CostMeter;
  /** true → użytkownik przerwał wyszukiwanie; adapter powinien skończyć jak najszybciej */
  cancelled: () => Promise<boolean>;
}

export interface SearchParams {
  icp: Icp;
  country: string;
  region: Region;
  center?: { lat: number; lng: number };
  radius_km?: number;
}

/** Adapter wyszukujący firmy (discovery). */
export interface DiscoveryAdapter {
  id: RawCompany["source"];
  search(p: SearchParams, ctx: AdapterContext, state: unknown): Promise<{ records: RawCompany[]; state: unknown; done: boolean }>;
}

/** Adapter wzbogacający po identyfikatorze (NIP/REGON/KRS). */
export interface EnrichmentAdapter {
  id: RawCompany["source"];
  /** Czy źródło pozwala SZUKAĆ po PKD + regionie? Jeśli false — używamy go tylko do weryfikacji. */
  supportsIndustryRegionSearch: boolean;
  enrichByNip?(nip: string, ctx: AdapterContext): Promise<RawCompany[]>;
}

export const nowIso = () => new Date().toISOString();

/** Prosty limiter: minimalny odstęp między zapytaniami do danego źródła. */
export function limiter(minIntervalMs: number) {
  let last = 0;
  let chain = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const wait = Math.max(0, last + minIntervalMs - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
    });
    chain = run.catch(() => {});
    return run.then(fn);
  };
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 10_000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}
