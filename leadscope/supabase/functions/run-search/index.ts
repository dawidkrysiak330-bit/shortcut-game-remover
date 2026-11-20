// =============================================================
// run-search — przetwarza wyszukiwanie w krokach ("tickach").
// Frontend wywołuje tę funkcję co ~2 s, dopóki status nie jest końcowy.
// Każdy tick pracuje max ~40 s (limity czasu Edge Functions), zapisuje stan
// w searches.job_state i postęp w searches.progress.
//
//   queued → discovering (Google Places) → enriching (www + rejestry) → scoring → done
//   w każdej chwili: cancel_requested → cancelled
// =============================================================
import type { SupabaseClient } from "@supabase/supabase-js";
import { getClients, handler, HttpError, json } from "../_shared/http.ts";
import { costMeter, type CostMeter } from "../_shared/costs.ts";
import { googlePlaces, geocodeCity } from "../_shared/adapters/googlePlaces.ts";
import { bialaLista } from "../_shared/adapters/bialaLista.ts";
import { gusBir } from "../_shared/adapters/gusBir.ts";
import { krsByNumber } from "../_shared/adapters/krs.ts";
import { ceidg } from "../_shared/adapters/ceidg.ts";
import { crawlWebsite } from "../_shared/adapters/website.ts";
import type { AdapterContext, SearchParams } from "../_shared/adapters/types.ts";
import { regionByCode } from "../_shared/core/regions.ts";
import { clusterRecords, clusterKey } from "../_shared/core/dedup.ts";
import { buildLeads } from "../_shared/core/pipeline.ts";
import { normalizeDomain, normalizeNip } from "../_shared/core/normalize.ts";
import { DEFAULT_WEIGHTS, type FieldValue, type RawCompany, type WebsitePage, type Weights } from "../_shared/core/types.ts";

const TICK_BUDGET_MS = 40_000;
const ENRICH_CONCURRENCY = 6;
/** Jak długo trzymamy treści z Google Places przy leadzie. ZWERYFIKUJ z aktualnymi warunkami Google (COMPLIANCE.md). */
const PLACES_TTL_HOURS = Number(Deno.env.get("PLACES_CONTENT_TTL_HOURS") ?? "24");

// deno-lint-ignore no-explicit-any
type Search = any;

Deno.serve(handler(async (req) => {
  const { search_id } = await req.json();
  if (!search_id) throw new HttpError(400, "Brak search_id");
  const { userClient, admin } = await getClients(req);

  // 1) Dostęp sprawdzamy klientem użytkownika (RLS) — jeśli nie widzi wyszukiwania, nie ma dostępu.
  const { data: visible } = await userClient.from("searches").select("id").eq("id", search_id).maybeSingle();
  if (!visible) throw new HttpError(404, "Nie znaleziono wyszukiwania");

  // 2) Blokada, żeby dwa ticki nie pracowały jednocześnie.
  const now = new Date();
  const { data: s } = await admin.from("searches")
    .update({ lock_until: new Date(now.getTime() + 60_000).toISOString() })
    .eq("id", search_id)
    .or(`lock_until.is.null,lock_until.lt.${now.toISOString()}`)
    .not("status", "in", "(done,cancelled,failed)")
    .select("*").maybeSingle();
  if (!s) {
    const { data: cur } = await admin.from("searches").select("id,status,progress,message,cost_usd,results_count").eq("id", search_id).single();
    return json(cur);
  }

  const meter = costMeter(admin, s.org_id, s.id);
  try {
    await tick(admin, s, meter);
  } catch (e) {
    console.error(e);
    await admin.from("searches").update({ status: "failed", error: String(e), message: "Błąd — szczegóły w polu error", finished_at: new Date().toISOString() }).eq("id", s.id);
  } finally {
    // koszt tego ticku dopisujemy do wyszukiwania
    const { data: cur } = await admin.from("searches").select("cost_usd").eq("id", s.id).single();
    await admin.from("searches").update({ lock_until: null, cost_usd: Number(cur?.cost_usd ?? 0) + meter.total() }).eq("id", s.id);
  }
  const { data: out } = await admin.from("searches").select("id,status,progress,message,cost_usd,results_count").eq("id", s.id).single();
  return json(out);
}));

async function update(admin: SupabaseClient, id: string, patch: Record<string, unknown>) {
  const { error } = await admin.from("searches").update(patch).eq("id", id);
  if (error) throw error;
}

async function tick(admin: SupabaseClient, s: Search, meter: CostMeter) {
  const started = Date.now();
  const timeLeft = () => TICK_BUDGET_MS - (Date.now() - started);
  const cancelled = async () => {
    const { data } = await admin.from("searches").select("cancel_requested").eq("id", s.id).single();
    return !!data?.cancel_requested;
  };
  const ctx: AdapterContext = { meter, cancelled };

  if (await cancelled()) {
    await admin.from("raw_records").delete().eq("search_id", s.id);
    return update(admin, s.id, { status: "cancelled", message: "Przerwane przez użytkownika", finished_at: new Date().toISOString() });
  }

  const region = regionByCode(s.country, s.region_code);
  if (!region) throw new Error(`Nieznany region ${s.country}/${s.region_code}`);
  const { data: org } = await admin.from("organizations").select("plan_id, retention_days").eq("id", s.org_id).single();
  const { data: plan } = await admin.from("plans").select("*").eq("id", org!.plan_id).single();
  if (!plan) throw new Error("Brak planu organizacji");
  const state = s.job_state ?? {};
  const overBudget = () => Number(s.cost_usd) + meter.total() >= Number(plan.max_cost_per_search_usd);

  // ---------- queued: limity planu + przygotowanie ----------
  if (s.status === "queued") {
    const { data: usage } = await admin.from("org_usage_month").select("*").eq("org_id", s.org_id).single();
    if (usage && usage.searches_this_month > plan.max_searches_per_month) {
      return update(admin, s.id, { status: "failed", message: "Przekroczono miesięczny limit wyszukiwań w planie", finished_at: new Date().toISOString() });
    }
    let center: { lat: number; lng: number } | undefined;
    if (s.city && s.radius_km) center = (await geocodeCity(`${s.city}, ${region.name}`, s.country, ctx)) ?? undefined;
    return update(admin, s.id, { status: "discovering", progress: 2, message: "Szukam firm w Google Places…", job_state: { center, places: null } });
  }

  const params: SearchParams = { icp: s.icp, country: s.country, region, center: state.center, radius_km: s.radius_km ?? undefined };

  // ---------- discovering: Google Places, strona po stronie ----------
  if (s.status === "discovering") {
    let placesState = state.places;
    let count = state.discovered ?? 0;
    while (timeLeft() > 8000) {
      if (await cancelled() || overBudget()) break;
      const r = await googlePlaces.search(params, ctx, placesState);
      placesState = r.state;
      if (r.records.length) {
        await admin.from("raw_records").insert(r.records.map((payload) => ({ search_id: s.id, source: "google_places", payload })));
        count += r.records.length;
      }
      const qi = (placesState as { qi: number }).qi;
      await update(admin, s.id, { progress: 2 + Math.round(30 * qi / Math.max(1, params.icp.keywords.length)), message: `Google Places: ${count} wyników` });
      if (r.done || count >= plan.max_results_per_search * 2) {
        return update(admin, s.id, { status: "enriching", job_state: { ...state, places: placesState, discovered: count, enriched: [] }, message: "Wzbogacam dane (www, rejestry)…" });
      }
    }
    return update(admin, s.id, { job_state: { ...state, places: placesState, discovered: count }, status: overBudget() ? "enriching" : "discovering" });
  }

  // ---------- enriching: www + rejestry po NIP ----------
  if (s.status === "enriching") {
    const raw = await loadRaw(admin, s.id);
    const clusters = clusterRecords(raw.filter((r) => !("pages" in r)) as RawCompany[]);
    const enriched = new Set<string>(state.enriched ?? []);
    const todo = clusters.filter((c) => !enriched.has(clusterKey(c)));
    while (todo.length && timeLeft() > 12_000 && !overBudget()) {
      if (await cancelled()) return;
      const batch = todo.splice(0, ENRICH_CONCURRENCY);
      await Promise.all(batch.map(async (cluster) => {
        const recs = await enrichCluster(cluster, ctx);
        if (recs.length) await admin.from("raw_records").insert(recs.map((payload) => ({ search_id: s.id, source: "source" in payload ? payload.source : "website_pages", payload })));
        enriched.add(clusterKey(cluster));
      }));
      await update(admin, s.id, {
        progress: 32 + Math.round(58 * enriched.size / Math.max(1, clusters.length)),
        message: `Wzbogacono ${enriched.size}/${clusters.length} firm`,
        job_state: { ...state, enriched: [...enriched] },
      });
    }
    if (todo.length === 0 || overBudget()) {
      return update(admin, s.id, { status: "scoring", progress: 92, message: overBudget() ? "Osiągnięto limit kosztu planu — liczę wynik z zebranych danych" : "Liczę scoring…" });
    }
    return;
  }

  // ---------- scoring: dedup + score + zapis leadów ----------
  if (s.status === "scoring") {
    const raw = await loadRaw(admin, s.id);
    const records = raw.filter((r) => !("pages" in r)) as RawCompany[];
    const pagesByDomain: Record<string, WebsitePage[]> = {};
    for (const r of raw) if ("pages" in r) pagesByDomain[r.domain] = r.pages;
    const weights = await loadWeights(admin, s.org_id);
    const suppressed = await loadSuppression(admin, s.org_id);
    await precomputeHashes(records.map((r) => normalizeNip(r.fields.nip as string)).filter((n): n is string => !!n));
    const leads = buildLeads(records, pagesByDomain, s.icp, { country: s.country, region_name: region.name, center: state.center, radius_km: s.radius_km ?? undefined }, weights)
      .filter((l) => !isSuppressed(l.company, suppressed))
      .slice(0, plan.max_results_per_search);

    const placesExpiry = new Date(Date.now() + PLACES_TTL_HOURS * 3600_000).toISOString();
    const leadExpiry = new Date(Date.now() + (org!.retention_days ?? 90) * 86400_000).toISOString();
    const rows = leads.map(({ company: c, score }) => {
      // Rozdzielamy treści Google (wygasają) od danych z rejestrów/www.
      const data: Record<string, FieldValue[]> = {};
      const places: Record<string, FieldValue[]> = {};
      for (const [k, list] of Object.entries(c.fields)) {
        for (const fv of list ?? []) ((fv.source === "google_places" ? places : data)[k] ??= []).push(fv);
      }
      const placeId = c.fields.place_id?.[0]?.value as string | undefined;
      return {
        org_id: s.org_id, search_id: s.id, dedup_key: c.key, place_id: placeId ?? null,
        nip: normalizeNip(c.fields.nip?.[0]?.value as string) ?? null,
        data, places_data: places, places_expires_at: placeId ? placesExpiry : null,
        website_pages: c.website_pages, score, score_total: score.total, confidence: score.confidence,
        excluded: score.excluded, is_natural_person: c.is_natural_person, expires_at: leadExpiry,
      };
    });
    for (let i = 0; i < rows.length; i += 50) {
      const { error } = await admin.from("leads").upsert(rows.slice(i, i + 50), { onConflict: "search_id,dedup_key" });
      if (error) throw error;
    }
    await admin.from("raw_records").delete().eq("search_id", s.id); // dane robocze — usuwamy
    return update(admin, s.id, { status: "done", progress: 100, results_count: rows.length, message: `Gotowe: ${rows.length} firm`, finished_at: new Date().toISOString() });
  }
}

type RawRow = RawCompany | { domain: string; pages: WebsitePage[] };

async function loadRaw(admin: SupabaseClient, searchId: string): Promise<RawRow[]> {
  const out: RawRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from("raw_records").select("payload").eq("search_id", searchId).order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []).map((d) => d.payload as RawRow));
    if (!data || data.length < 1000) return out;
  }
}

/** Wzbogacenie jednej firmy: www → NIP → Biała lista, GUS, KRS, CEIDG. */
async function enrichCluster(cluster: RawCompany[], ctx: AdapterContext): Promise<RawRow[]> {
  const out: RawRow[] = [];
  const website = cluster.map((r) => r.fields.website).find(Boolean) as string | undefined;
  const domain = normalizeDomain(website);
  let nip = cluster.map((r) => normalizeNip(r.fields.nip as string)).find(Boolean) ?? null;
  if (website && domain) {
    try {
      const { pages, records } = await crawlWebsite(website, ctx);
      if (pages.length) out.push({ domain, pages });
      out.push(...records);
      nip ??= records.map((r) => normalizeNip(r.fields.nip as string)).find(Boolean) ?? null;
    } catch (e) { console.warn("www", website, e); }
  }
  if (nip) {
    const safe = async (fn: () => Promise<RawCompany[]>) => { try { return await fn(); } catch (e) { console.warn(e); return []; } };
    const [bl, gus] = await Promise.all([safe(() => bialaLista.enrichByNip!(nip!, ctx)), safe(() => gusBir.enrichByNip!(nip!, ctx))]);
    out.push(...bl, ...gus);
    const krs = [...bl, ...gus].map((r) => r.fields.krs as string | undefined).find(Boolean);
    if (krs) out.push(...await safe(() => krsByNumber(krs, ctx)));
    if (gus.some((r) => r.is_natural_person)) out.push(...await safe(() => ceidg.enrichByNip!(nip!, ctx)));
  }
  return out;
}

async function loadWeights(admin: SupabaseClient, orgId: string): Promise<Weights> {
  const { data } = await admin.from("scoring_weights").select("*").or(`org_id.eq.${orgId},org_id.is.null`);
  const row = data?.find((r) => r.org_id === orgId) ?? data?.find((r) => r.org_id === null);
  if (!row) return DEFAULT_WEIGHTS;
  return {
    industry: row.industry, buying_signals: row.buying_signals, scale: row.scale, location: row.location,
    activity: row.activity, contact: row.contact, unknown_scale_factor: Number(row.unknown_scale_factor),
  };
}

async function loadSuppression(admin: SupabaseClient, orgId: string) {
  const { data } = await admin.from("suppression_list").select("nip_hash, domain").or(`org_id.eq.${orgId},org_id.is.null`);
  return { nipHashes: new Set((data ?? []).map((d) => d.nip_hash).filter(Boolean)), domains: new Set((data ?? []).map((d) => d.domain).filter(Boolean)) };
}

const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const hashCache = new Map<string, string>();

function isSuppressed(c: { fields: Record<string, FieldValue[] | undefined> }, sup: { nipHashes: Set<string>; domains: Set<string> }): boolean {
  const domain = normalizeDomain(c.fields.website?.[0]?.value as string);
  if (domain && sup.domains.has(domain)) return true;
  const nip = normalizeNip(c.fields.nip?.[0]?.value as string);
  return !!nip && sup.nipHashes.has(hashCache.get(nip) ?? "");
}

// Hash SHA-256 jest asynchroniczny — liczymy go z wyprzedzeniem dla wszystkich NIP-ów w danych.
async function precomputeHashes(nips: string[]) {
  for (const n of nips) if (!hashCache.has(n)) hashCache.set(n, await sha256(n));
}
