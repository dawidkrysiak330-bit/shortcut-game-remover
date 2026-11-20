// =============================================================
// Warstwa API frontendu. Dwie implementacje o tym samym interfejsie:
//  - realApi: Supabase (Auth + tabele z RLS + Edge Functions)
//  - mockApi: tryb demo / testy E2E — bez sieci, na danych fikcyjnych,
//    ale z PRAWDZIWĄ deduplikacją i scoringiem (kod z core/).
// =============================================================
import { supabase } from "./supabase";
import type { FieldValue, Icp, MergedCompany, ScoreResult, Weights } from "../../supabase/functions/_shared/core/types.ts";
import { DEFAULT_WEIGHTS } from "../../supabase/functions/_shared/core/types.ts";
import type { LeadCardLlm } from "../../supabase/functions/_shared/core/schemas.ts";
import { NO_DESCRIPTION, groundingErrors } from "../../supabase/functions/_shared/core/schemas.ts";
import { buildLeads } from "../../supabase/functions/_shared/core/pipeline.ts";
import { regionByCode } from "../../supabase/functions/_shared/core/regions.ts";
import { MOCK_ICP, mockRawRecords } from "./mockData";

/** AI (Claude) jest płatne — domyślnie WYŁĄCZONE. Włączenie: VITE_AI_ENABLED=true + sekret AI_ENABLED=true w Edge Functions. */
export const AI_ENABLED = import.meta.env.VITE_AI_ENABLED === "true";

export type SearchStatus = {
  id: string;
  status: "queued" | "discovering" | "enriching" | "scoring" | "done" | "cancelled" | "failed";
  progress: number;
  message: string | null;
  cost_usd: number;
  results_count: number;
};

export type Card = LeadCardLlm & { generated_at?: string; rejected_reasons?: string[] };

export interface LeadRow {
  id: string;
  search_id: string;
  company: MergedCompany;
  score: ScoreResult;
  card: Card | null;
  place_id: string | null;
  places_expired: boolean;
  is_natural_person: boolean;
  product: string;
}

export interface StartParams {
  icp: Icp;
  country: string;
  region_code: string;
  city?: string;
  radius_km?: number;
}

export interface UsageInfo {
  plan: string;
  searches_this_month: number;
  max_searches: number;
  cost_this_month_usd: number;
  unverified_prices: string[];
  per_search: { id: string; created_at: string; cost_usd: number; results_count: number; status: string }[];
}

export interface Api {
  mode: "mock" | "supabase";
  session(): Promise<{ email: string } | null>;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  generateIcp(phrase: string): Promise<Icp>;
  startSearch(p: StartParams): Promise<string>;
  tick(searchId: string): Promise<SearchStatus>;
  cancel(searchId: string): Promise<void>;
  listLeads(searchId: string): Promise<LeadRow[]>;
  getLead(id: string): Promise<LeadRow>;
  generateCard(id: string): Promise<Card>;
  refreshPlaces(id: string): Promise<Record<string, FieldValue[]> | null>;
  getWeights(): Promise<Weights>;
  saveWeights(w: Weights): Promise<void>;
  usage(): Promise<UsageInfo>;
  eraseSubject(nip: string | null, domain: string | null): Promise<number>;
}

// ---------------------------------------------------------------- Supabase

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToLead(r: any): LeadRow {
  const placesValid = r.places_data && r.places_expires_at && new Date(r.places_expires_at) > new Date();
  const fields: MergedCompany["fields"] = structuredClone(r.data ?? {});
  if (placesValid) {
    for (const [k, v] of Object.entries(r.places_data as Record<string, FieldValue[]>)) {
      (fields as Record<string, FieldValue[]>)[k] = [...((fields as Record<string, FieldValue[]>)[k] ?? []), ...v];
    }
  }
  return {
    id: r.id, search_id: r.search_id, score: r.score, card: r.card, place_id: r.place_id,
    places_expired: !!r.place_id && !placesValid, is_natural_person: r.is_natural_person,
    product: r.searches?.icp?.product ?? "",
    company: { key: r.dedup_key, fields, sources: [], website_pages: r.website_pages ?? [], is_natural_person: r.is_natural_person },
  };
}

async function myOrgId(): Promise<string> {
  const { data, error } = await supabase!.from("memberships").select("org_id").limit(1).single();
  if (error) throw error;
  return data.org_id;
}

async function invoke<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase!.functions.invoke(name, { body });
  if (error) {
    // spróbuj wyciągnąć komunikat z treści odpowiedzi
    const ctx = (error as { context?: Response }).context;
    const msg = ctx ? (await ctx.json().catch(() => null))?.error : null;
    throw new Error(msg ?? error.message);
  }
  return data as T;
}

const realApi: Api = {
  mode: "supabase",
  async session() {
    const { data } = await supabase!.auth.getSession();
    return data.session ? { email: data.session.user.email ?? "" } : null;
  },
  async signIn(email, password) {
    const { error } = await supabase!.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },
  async signUp(email, password) {
    const { error } = await supabase!.auth.signUp({ email, password });
    if (error) throw error;
  },
  async signOut() { await supabase!.auth.signOut(); },
  async generateIcp(phrase) {
    const r = await invoke<{ icp: Icp }>("generate-icp", { phrase, org_id: await myOrgId() });
    return r.icp;
  },
  async startSearch(p) {
    const { data, error } = await supabase!.from("searches")
      .insert({ org_id: await myOrgId(), icp: p.icp, country: p.country, region_code: p.region_code, city: p.city || null, radius_km: p.radius_km || null })
      .select("id").single();
    if (error) throw error;
    return data.id;
  },
  tick: (searchId) => invoke<SearchStatus>("run-search", { search_id: searchId }),
  async cancel(searchId) {
    const { error } = await supabase!.from("searches").update({ cancel_requested: true }).eq("id", searchId);
    if (error) throw error;
  },
  async listLeads(searchId) {
    const { data, error } = await supabase!.from("leads").select("*, searches(icp)").eq("search_id", searchId).order("score_total", { ascending: false });
    if (error) throw error;
    return (data ?? []).map(rowToLead);
  },
  async getLead(id) {
    const { data, error } = await supabase!.from("leads").select("*, searches(icp)").eq("id", id).single();
    if (error) throw error;
    return rowToLead(data);
  },
  async generateCard(id) { return (await invoke<{ card: Card }>("lead-card", { lead_id: id })).card; },
  async refreshPlaces(id) {
    return (await invoke<{ places_data: Record<string, FieldValue[]> | null }>("lead-card", { lead_id: id, action: "refresh_places" })).places_data;
  },
  async getWeights() {
    const { data } = await supabase!.from("scoring_weights").select("*");
    const orgId = await myOrgId();
    const row = data?.find((r) => r.org_id === orgId) ?? data?.find((r) => r.org_id === null);
    return row ? { ...DEFAULT_WEIGHTS, ...row, unknown_scale_factor: Number(row.unknown_scale_factor) } : DEFAULT_WEIGHTS;
  },
  async saveWeights(w) {
    const { error } = await supabase!.from("scoring_weights").upsert({ org_id: await myOrgId(), ...w, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
    if (error) throw error;
  },
  async usage() {
    const orgId = await myOrgId();
    const [{ data: u }, { data: org }, { data: prices }, { data: searches }] = await Promise.all([
      supabase!.from("org_usage_month").select("*").eq("org_id", orgId).single(),
      supabase!.from("organizations").select("plan_id, plans(max_searches_per_month)").eq("id", orgId).single(),
      supabase!.from("source_pricing").select("source, sku, verified"),
      supabase!.from("searches").select("id, created_at, cost_usd, results_count, status").order("created_at", { ascending: false }).limit(20),
    ]);
    const plan = org?.plans as unknown as { max_searches_per_month: number } | null;
    return {
      plan: org?.plan_id ?? "?",
      searches_this_month: u?.searches_this_month ?? 0,
      max_searches: plan?.max_searches_per_month ?? 0,
      cost_this_month_usd: Number(u?.cost_this_month_usd ?? 0),
      unverified_prices: (prices ?? []).filter((p) => !p.verified).map((p) => `${p.source}/${p.sku}`),
      per_search: (searches ?? []).map((s) => ({ ...s, cost_usd: Number(s.cost_usd) })),
    };
  },
  async eraseSubject(nip, domain) {
    const { data, error } = await supabase!.rpc("erase_subject", { p_org: await myOrgId(), p_nip: nip, p_domain: domain, p_note: "żądanie podmiotu" });
    if (error) throw error;
    return data as number;
  },
};

// ---------------------------------------------------------------- Mock (demo / E2E)

const mem: { searches: Record<string, SearchStatus & { p: StartParams; ticks: number }>; leads: Record<string, LeadRow>; weights: Weights } = {
  searches: {}, leads: {}, weights: { ...DEFAULT_WEIGHTS },
};

/** Deterministyczna "karta LLM" z danych — w trybie demo nie wołamy modelu. */
function mockCard(l: LeadRow): Card {
  const text = l.company.website_pages[0]?.text;
  const card: Card = {
    description: text ? text.split(". ").slice(0, 2).join(". ") + "." : NO_DESCRIPTION,
    why_buy: [
      ...l.score.components.buying_signals.evidence.slice(0, 2).map((e): Card["why_buy"][number] => ({ point: `Na stronie www: ${e.snippet}`, evidence_field: "website_text" })),
      ...(l.company.fields.pkd?.length ? [{ point: `Działalność wg PKD: ${String(l.company.fields.pkd[0].value)}`, evidence_field: "pkd" } as Card["why_buy"][number]] : []),
    ].slice(0, 3),
    talk_angle: `Zapytaj, jak firma obecnie zaopatruje się w: ${l.product}.`,
    opening_questions: [`Jak dziś organizujecie zakupy: ${l.product}?`, "Kto u Państwa decyduje o wyborze dostawcy?", "Co jest dla Państwa najważniejsze przy zmianie dostawcy?"],
  };
  return { ...card, generated_at: new Date().toISOString(), rejected_reasons: groundingErrors(card, l.company, l.product) };
}

const mockApi: Api = {
  mode: "mock",
  session: async () => ({ email: "demo@example.com" }),
  signIn: async () => {},
  signUp: async () => {},
  signOut: async () => {},
  generateIcp: async (phrase) => ({ ...MOCK_ICP, product: phrase }),
  async startSearch(p) {
    const id = `mock-${Date.now()}`;
    mem.searches[id] = { id, status: "queued", progress: 0, message: null, cost_usd: 0, results_count: 0, p, ticks: 0 };
    return id;
  },
  async tick(id) {
    const s = mem.searches[id];
    if (["done", "cancelled", "failed"].includes(s.status)) return s;
    s.ticks++;
    const steps: SearchStatus["status"][] = ["discovering", "enriching", "scoring", "done"];
    s.status = steps[Math.min(s.ticks - 1, 3)];
    s.progress = [10, 45, 90, 100][Math.min(s.ticks - 1, 3)];
    s.message = s.status === "done" ? "Gotowe" : `Etap: ${s.status}`;
    s.cost_usd = 0.012 * s.ticks; // symulowany koszt
    if (s.status === "done") {
      const { raw, pages } = mockRawRecords(40);
      const region = regionByCode(s.p.country, s.p.region_code)!;
      const leads = buildLeads(raw, pages, s.p.icp, { country: s.p.country, region_name: region.name }, mem.weights);
      leads.forEach((l, i) => {
        const lid = `${id}-${i}`;
        mem.leads[lid] = {
          id: lid, search_id: id, company: l.company, score: l.score, card: null,
          place_id: (l.company.fields.place_id?.[0]?.value as string) ?? null, places_expired: false,
          is_natural_person: l.company.is_natural_person, product: s.p.icp.product,
        };
      });
      s.results_count = leads.length;
    }
    return { ...s };
  },
  async cancel(id) { mem.searches[id].status = "cancelled"; mem.searches[id].message = "Przerwane przez użytkownika"; },
  listLeads: async (id) => Object.values(mem.leads).filter((l) => l.search_id === id),
  async getLead(id) { const l = mem.leads[id]; if (!l) throw new Error("Brak leada (tryb demo — dane w pamięci; zacznij nowe wyszukiwanie)"); return l; },
  async generateCard(id) { const c = mockCard(mem.leads[id]); mem.leads[id].card = c; return c; },
  refreshPlaces: async () => null,
  getWeights: async () => mem.weights,
  async saveWeights(w) { mem.weights = w; },
  usage: async () => ({
    plan: "demo", searches_this_month: Object.keys(mem.searches).length, max_searches: 10,
    cost_this_month_usd: Object.values(mem.searches).reduce((a, s) => a + s.cost_usd, 0),
    unverified_prices: ["google_places/text_search_enterprise (demo)"],
    per_search: Object.values(mem.searches).map((s) => ({ id: s.id, created_at: new Date().toISOString(), cost_usd: s.cost_usd, results_count: s.results_count, status: s.status })),
  }),
  async eraseSubject(nip) {
    let n = 0;
    for (const [k, l] of Object.entries(mem.leads)) if (nip && l.company.fields.nip?.some((v) => v.value === nip)) { delete mem.leads[k]; n++; }
    return n;
  },
};

export const api: Api = import.meta.env.VITE_USE_MOCK === "true" || !supabase ? mockApi : realApi;
