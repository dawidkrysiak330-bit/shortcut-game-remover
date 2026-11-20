// =============================================================
// VIES (Komisja Europejska) — weryfikacja numeru VAT UE.
// Docs (ZWERYFIKUJ endpoint REST): https://ec.europa.eu/taxation_customs/vies/
// Tylko weryfikacja numeru — brak wyszukiwania firm.
// =============================================================
import type { RawCompany } from "../core/types.ts";
import type { AdapterContext } from "./types.ts";
import { fetchWithTimeout, limiter, nowIso } from "./types.ts";

const URL = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";
const rate = limiter(1000);

export async function viesCheck(countryCode: string, vatNumber: string, ctx: AdapterContext): Promise<RawCompany[]> {
  const res = await rate(() => fetchWithTimeout(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ countryCode, vatNumber }),
  }));
  await ctx.meter.record("vies", "check", 1);
  if (!res.ok) return [];
  const d = await res.json();
  if (!d.valid) return [];
  return [{
    source: "vies", source_url: URL, fetched_at: nowIso(),
    fields: { nip: countryCode === "PL" ? vatNumber : undefined, name: d.name && d.name !== "---" ? d.name : undefined, vat_status: "VAT UE aktywny" },
  }];
}
