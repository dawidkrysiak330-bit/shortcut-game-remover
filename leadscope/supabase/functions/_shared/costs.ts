// Licznik kosztów API: każde wywołanie płatnego/limitowanego źródła zapisujemy w api_usage.
import type { SupabaseClient } from "@supabase/supabase-js";

/** Twardy miesięczny limit zapytań do Google (wspólny dla całej aplikacji — jeden klucz API). */
export const GOOGLE_MONTHLY_LIMIT = Number(Deno.env.get("GOOGLE_MONTHLY_REQUEST_LIMIT") ?? "900");

/** Ile zapytań do Google wykonano w bieżącym miesiącu (z tabeli api_usage). */
export async function googleUsedThisMonth(admin: SupabaseClient): Promise<number> {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  let total = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("api_usage").select("units").eq("source", "google_places").gte("created_at", start.toISOString()).range(from, from + 999);
    if (error) throw error;
    total += (data ?? []).reduce((a, r) => a + Number(r.units), 0);
    if (!data || data.length < 1000) return total;
  }
}

let pricingCache: Map<string, number> | null = null;

async function pricing(admin: SupabaseClient): Promise<Map<string, number>> {
  if (pricingCache) return pricingCache;
  const { data } = await admin.from("source_pricing").select("source, sku, unit, unit_cost_usd");
  pricingCache = new Map((data ?? []).map((r) => [`${r.source}|${r.sku}|${r.unit}`, Number(r.unit_cost_usd)]));
  return pricingCache;
}

export interface CostMeter {
  /** units: liczba zapytań albo miliony tokenów (unit = mtok_in / mtok_out). */
  record(source: string, sku: string, units: number, unit?: string): Promise<number>;
  total(): number;
}

export function costMeter(admin: SupabaseClient, orgId: string, searchId: string | null): CostMeter {
  let total = 0;
  return {
    async record(source, sku, units, unit = "request") {
      const price = (await pricing(admin)).get(`${source}|${sku}|${unit}`) ?? 0;
      const cost = price * units;
      total += cost;
      await admin.from("api_usage").insert({ org_id: orgId, search_id: searchId, source, sku: unit === "request" ? sku : `${sku}:${unit}`, units, cost_usd: cost });
      return cost;
    },
    total: () => total,
  };
}
