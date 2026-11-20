// =============================================================
// lead-card — generuje kartę leada (opis, "dlaczego kupi", kąt rozmowy, pytania)
// WYŁĄCZNIE z zebranych danych, oraz odświeża treści Google Places po place_id.
// Odpowiedź LLM: walidacja zod + kontrola ugruntowania → inaczej odrzucenie, log i karta "BRAK DANYCH".
// =============================================================
import { getClients, handler, HttpError, json } from "../_shared/http.ts";
import { callJson } from "../_shared/llm.ts";
import { costMeter } from "../_shared/costs.ts";
import { getPlace } from "../_shared/adapters/googlePlaces.ts";
import { fallbackCard, groundingErrors, LeadCardLlmSchema, NO_DESCRIPTION } from "../_shared/core/schemas.ts";
import type { FieldValue, MergedCompany } from "../_shared/core/types.ts";

const SYSTEM = `Przygotowujesz kartę leada dla handlowca. Korzystasz WYŁĄCZNIE z danych w sekcji DANE (rejestry + strona www firmy).
Zwróć JSON:
{"description": string — max 3 zdania: czym zajmuje się firma, tylko z danych; jeśli danych za mało, wpisz dokładnie "${NO_DESCRIPTION}",
 "why_buy": [{"point": string, "evidence_field": nazwa pola z DANYCH, na którym opierasz punkt, lub "website_text"}] — 0–3 punkty, dlaczego firma może kupić PRODUKT,
 "talk_angle": string — 1–2 zdania: od czego zacząć rozmowę,
 "opening_questions": string[] — max 3 otwarte pytania}
Nie podawaj liczb, nazw klientów, certyfikatów ani innych faktów, których nie ma w DANYCH.`;

Deno.serve(handler(async (req) => {
  const { lead_id, action } = await req.json();
  const { userClient, admin } = await getClients(req);
  const { data: lead } = await userClient.from("leads").select("*, searches(icp)").eq("id", lead_id).maybeSingle();
  if (!lead) throw new HttpError(404, "Nie znaleziono leada");
  const meter = costMeter(admin, lead.org_id, lead.search_id);

  // Odświeżenie danych Google po place_id (treści nie trzymamy trwale)
  if (action === "refresh_places") {
    if (!lead.place_id) return json({ places_data: null });
    const rec = await getPlace(lead.place_id, { meter, cancelled: async () => false });
    const places: Record<string, FieldValue[]> = {};
    for (const [k, v] of Object.entries(rec?.fields ?? {})) {
      if (v !== undefined && k !== "place_id") places[k] = [{ value: v, source: "google_places", source_url: rec!.source_url, fetched_at: rec!.fetched_at }];
    }
    // zwracamy do wyświetlenia; NIE zapisujemy ponownie w bazie
    return json({ places_data: places, cost_usd: meter.total() });
  }

  // Generowanie karty — wejście: tylko dane z rejestrów i www (+ ewentualnie jeszcze ważne dane Google)
  const fields = { ...(lead.data ?? {}) } as MergedCompany["fields"];
  if (lead.places_data && lead.places_expires_at && new Date(lead.places_expires_at) > new Date()) {
    for (const [k, v] of Object.entries(lead.places_data)) (fields as Record<string, FieldValue[]>)[k] = [...((fields as Record<string, FieldValue[]>)[k] ?? []), ...(v as FieldValue[])];
  }
  const company: MergedCompany = { key: lead.dedup_key, fields, sources: [], website_pages: lead.website_pages ?? [], is_natural_person: lead.is_natural_person };
  const facts = {
    pola: Object.fromEntries(Object.entries(fields).map(([k, list]) => [k, (list ?? []).map((fv) => fv.value)])),
    strona_www: company.website_pages.map((p) => ({ url: p.url, tekst: p.text.slice(0, 4000) })),
  };
  const product = lead.searches?.icp?.product ?? "";
  const res = await callJson({
    system: SYSTEM,
    user: `PRODUKT: ${product}\n\nDANE:\n${JSON.stringify(facts)}`,
    schema: LeadCardLlmSchema, meter, effort: "low",
  });

  let card = fallbackCard();
  let rejected: string[] = [];
  if (res.ok) {
    const errs = groundingErrors(res.data, company, product);
    if (errs.length === 0) card = res.data;
    else rejected = errs;
  } else rejected = res.errors;
  if (rejected.length) {
    await admin.from("llm_rejections").insert({ org_id: lead.org_id, kind: "lead_card", ref_id: lead.id, raw_output: res.raw.slice(0, 20000), errors: rejected });
  }
  const stored = { ...card, generated_at: new Date().toISOString(), rejected_reasons: rejected };
  await admin.from("leads").update({ card: stored }).eq("id", lead.id);
  return json({ card: stored, cost_usd: meter.total() });
}));
