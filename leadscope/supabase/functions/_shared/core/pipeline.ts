// =============================================================
// Pipeline bez I/O: surowe rekordy → deduplikacja → scoring.
// Używa go Edge Function `run-search`, a testy uruchamiają go na mockach.
// =============================================================
import type { Icp, MergedCompany, RawCompany, ScoreResult, SearchContext, WebsitePage, Weights } from "./types.ts";
import { dedupe, firstString } from "./dedup.ts";
import { scoreCompany } from "./scoring.ts";
import { normText } from "./normalize.ts";

export interface Lead {
  company: MergedCompany;
  score: ScoreResult;
}

export function buildLeads(
  raw: RawCompany[],
  pagesByDomain: Record<string, WebsitePage[]>,
  icp: Icp,
  ctx: SearchContext,
  weights: Weights,
): Lead[] {
  const companies = dedupe(raw, pagesByDomain)
    // poza wybranym regionem (jeśli region znany) — odrzucamy (filtr obowiązkowy)
    .filter((c) => {
      const regions = (c.fields.region ?? []).map((v) => normText(String(v.value)));
      return regions.length === 0 || regions.some((r) => r.includes(normText(ctx.region_name)));
    });
  return companies
    .map((company) => ({ company, score: scoreCompany(company, icp, ctx, weights) }))
    .sort((a, b) => b.score.total - a.score.total);
}

// ---------- filtry dodatkowe (używane w widoku wyników) ----------

export interface LeadFilters {
  pkd?: string; // prefiks, np. "25" albo "25.62"
  legal_form?: string;
  status?: string;
  min_score?: number;
  only_with_website?: boolean;
  only_with_phone?: boolean;
  hide_excluded?: boolean;
}

export function applyFilters(leads: Lead[], f: LeadFilters): Lead[] {
  return leads.filter(({ company: c, score: s }) => {
    if (f.min_score !== undefined && s.total < f.min_score) return false;
    if (f.hide_excluded && s.excluded) return false;
    if (f.only_with_website && !c.fields.website?.length) return false;
    if (f.only_with_phone && !c.fields.phone?.length) return false;
    if (f.pkd) {
      const p = f.pkd.replace(/\./g, "");
      const codes = (c.fields.pkd ?? []).flatMap((v) => (Array.isArray(v.value) ? v.value : [v.value]));
      if (!codes.some((code) => code.replace(/\./g, "").startsWith(p))) return false;
    }
    if (f.legal_form && !normText(firstString(c, "legal_form") ?? "").includes(normText(f.legal_form))) return false;
    if (f.status && !normText(firstString(c, "status") ?? firstString(c, "vat_status") ?? "").includes(normText(f.status))) return false;
    return true;
  });
}
