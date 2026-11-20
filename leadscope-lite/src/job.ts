// =============================================================
// Zadanie wyszukiwania: frazy → Google Places (oficjalne API) → strony www → (opcjonalnie) Biała lista.
// Wszystko trzymane TYLKO w pamięci serwera i kasowane po JOB_TTL — nie budujemy trwałej bazy z treści Google.
// Wykorzystuje gotowe funkcje z projektu docelowego (leadscope/…/core).
// =============================================================
import { extractGenericEmails, extractNips, extractPhones, normalizeDomain, normalizePhone, normText } from "../../leadscope/supabase/functions/_shared/core/normalize.ts";
import { htmlToText, isAllowedByRobots, pickSubpages } from "../../leadscope/supabase/functions/_shared/core/web.ts";
import type { Region } from "../../leadscope/supabase/functions/_shared/core/regions.ts";
import type { Place, Providers } from "./providers.ts";

/** Wartość + źródło + data pobrania (każde pole ma źródło). */
export interface Sourced { value: string; source: "website" | "biala_lista"; url: string; fetched_at: string }

export interface Lead {
  place: Place; // treść z Google — tylko do podglądu, NIE trafia do eksportu
  found_in: string[]; // frazy, które zwróciły tę firmę
  website?: Sourced; // potwierdzona strona (odpowiedziała)
  nip?: Sourced;
  email?: Sourced; // tylko adres rolowy (biuro@, info@ …)
  phone?: Sourced; // telefon ze strony kontaktowej firmy
  official_name?: Sourced;
  official_address?: Sourced;
  vat_status?: Sourced;
  regon?: Sourced;
  krs?: Sourced;
  www_note?: string; // np. "robots.txt nie pozwala", "strona blokuje boty"
}

export interface JobParams {
  phrases: string[];
  region: Region;
  city?: string;
  radius_km?: number;
  crawl_websites: boolean;
  use_biala_lista: boolean;
  max_results: number;
}

export interface Job {
  id: string;
  params: JobParams;
  status: "running" | "done" | "cancelled" | "failed";
  stage: string;
  progress: number;
  error?: string;
  places_requests: number;
  biala_lista_requests: number;
  leads: Lead[];
  created_at: number;
  cancel: boolean;
}

export const USER_AGENT = `LeadScopeLite/0.1 (+${process.env.BOT_INFO_URL ?? "https://example.com/bot"})`;
const PAGES_PER_PHRASE = 3; // 3 × 20 wyników (limit API — ZWERYFIKUJ)
const CRAWL_CONCURRENCY = 5;
const DELAY_PER_DOMAIN_MS = 1500;
// W trybie demo skracamy przerwy (brak prawdziwych serwerów do oszczędzania).
const DELAY_SCALE = process.argv.includes("--demo") || process.env.LITE_MOCK === "1" ? 0.02 : 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * DELAY_SCALE));
const now = () => new Date().toISOString();

export async function runJob(job: Job, p: Providers): Promise<void> {
  try {
    // ---------- 1. Google Places ----------
    const { region, city, radius_km } = job.params;
    let center = { lat: region.capital.lat, lng: region.capital.lng };
    if (city) {
      job.stage = `Ustalam położenie: ${city}`;
      const g = await p.geocode(`${city}, ${region.name}`);
      job.places_requests++;
      if (g) center = g;
    }
    const radiusM = (radius_km ?? 50) * 1000;
    const byId = new Map<string, Lead>();
    const phrases = job.params.phrases;
    for (let i = 0; i < phrases.length && !job.cancel; i++) {
      const query = city ? `${phrases[i]} ${city}` : `${phrases[i]} województwo ${region.name}`;
      let token: string | undefined;
      for (let page = 0; page < PAGES_PER_PHRASE && !job.cancel; page++) {
        job.stage = `Google Places: „${phrases[i]}” — strona ${page + 1}`;
        const r = await p.placesSearch(query, center, radiusM, token);
        job.places_requests++;
        for (const pl of r.places) {
          // filtr obowiązkowy: województwo (jeśli Google je podał)
          if (pl.region && !normText(pl.region).includes(normText(region.name))) continue;
          if (pl.business_status === "CLOSED_PERMANENTLY") continue;
          const ex = byId.get(pl.place_id);
          if (ex) { if (!ex.found_in.includes(phrases[i])) ex.found_in.push(phrases[i]); }
          else byId.set(pl.place_id, { place: pl, found_in: [phrases[i]] });
        }
        job.progress = Math.round(40 * (i + (page + 1) / PAGES_PER_PHRASE) / phrases.length);
        token = r.nextPageToken;
        if (!token || byId.size >= job.params.max_results) break;
      }
      if (byId.size >= job.params.max_results) break;
    }
    // Deduplikacja 2: różne place_id, ta sama domena lub telefon (oddziały/duplikaty wpisów)
    const seen = new Set<string>();
    job.leads = [...byId.values()].filter((l) => {
      const keys = [normalizeDomain(l.place.website), normalizePhone(l.place.phone)].filter(Boolean) as string[];
      if (keys.some((k) => seen.has(k))) return false;
      keys.forEach((k) => seen.add(k));
      return true;
    }).slice(0, job.params.max_results);

    // ---------- 2. Strony www ----------
    if (job.params.crawl_websites) {
      const todo = job.leads.filter((l) => l.place.website);
      let done = 0;
      const worker = async () => {
        while (todo.length && !job.cancel) {
          const lead = todo.shift()!;
          await crawl(lead, p).catch((e) => { lead.www_note = `błąd: ${String(e).slice(0, 80)}`; });
          done++;
          job.stage = `Strony www: ${done}/${done + todo.length}`;
          job.progress = 40 + Math.round(45 * done / Math.max(1, done + todo.length));
        }
      };
      await Promise.all(Array.from({ length: CRAWL_CONCURRENCY }, worker));
    }

    // ---------- 3. Biała lista (po NIP ze strony) ----------
    if (job.params.use_biala_lista) {
      const withNip = job.leads.filter((l) => l.nip);
      for (let i = 0; i < withNip.length && !job.cancel; i++) {
        const l = withNip[i];
        job.stage = `Biała lista VAT: ${i + 1}/${withNip.length}`;
        const r = await p.bialaLista(l.nip!.value).catch(() => null);
        job.biala_lista_requests++;
        if (r) {
          const t = now();
          const s = (value?: string): Sourced | undefined => (value ? { value, source: "biala_lista", url: r.url, fetched_at: t } : undefined);
          l.official_name = s(r.name); l.official_address = s(r.address); l.vat_status = s(r.statusVat); l.regon = s(r.regon); l.krs = s(r.krs);
        }
        job.progress = 85 + Math.round(14 * (i + 1) / withNip.length);
        await sleep(1000); // limit zapytań — nie przeciążamy API
      }
    }
    job.status = job.cancel ? "cancelled" : "done";
    job.stage = job.cancel ? "Przerwane przez użytkownika" : `Gotowe: ${job.leads.length} firm`;
    job.progress = 100;
  } catch (e) {
    job.status = "failed";
    job.error = String(e instanceof Error ? e.message : e);
    job.stage = "Błąd";
  }
}

/** Strona główna + (kontakt, o nas, oferta). robots.txt, jawny User-Agent, przerwa między zapytaniami. */
async function crawl(lead: Lead, p: Providers) {
  const base = new URL(lead.place.website!);
  let robots: string | null = null;
  try {
    const r = await p.fetchText(new URL("/robots.txt", base).href, USER_AGENT);
    robots = r.status === 200 ? r.body : null;
  } catch { robots = null; }
  const queue = [base.href];
  const visited = new Set<string>();
  let pages = 0;
  while (queue.length && pages < 4) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    if (!isAllowedByRobots(robots, USER_AGENT, new URL(url).pathname)) {
      if (pages === 0) lead.www_note = "robots.txt nie pozwala na pobranie";
      continue;
    }
    if (pages > 0) await sleep(DELAY_PER_DOMAIN_MS);
    const r = await p.fetchText(url, USER_AGENT);
    if ([401, 403, 429].includes(r.status) || /g-recaptcha|cf-challenge/i.test(r.body)) {
      lead.www_note = "strona blokuje automatyczne pobieranie — pominięto";
      return; // nie obchodzimy blokad
    }
    if (r.status !== 200 || !r.contentType.includes("html")) continue;
    pages++;
    const t = now();
    const text = htmlToText(r.body);
    const src = (value: string): Sourced => ({ value, source: "website", url, fetched_at: t });
    if (pages === 1) {
      lead.website = src(base.origin);
      queue.push(...pickSubpages(r.body, url));
    }
    const nip = extractNips(text)[0];
    if (nip && !lead.nip) lead.nip = src(nip);
    const email = extractGenericEmails(text)[0];
    if (email && !lead.email) lead.email = src(email);
    if (/kontakt|contact/i.test(url)) {
      const phone = extractPhones(text)[0];
      if (phone && !lead.phone) lead.phone = src(phone);
    }
  }
}

// ---------------------------------------------------------------- eksport CSV

/**
 * Eksport BEZ treści Google (nazwa, adres, telefon, ocena z Map) — tylko place_id i link do Map.
 * Reszta pochodzi ze strony www firmy i z Białej listy, z podanym źródłem i datą.
 */
export function toCsv(leads: Lead[]): string {
  const header = ["Nazwa (Biała lista)", "Adres (Biała lista)", "NIP", "REGON", "KRS", "Status VAT", "WWW", "E-mail firmowy (www)", "Telefon (strona kontaktowa)",
    "Frazy", "Google place_id", "Link do Google Maps", "Uwagi www", "Źródła"];
  const cell = (s?: Sourced) => s?.value ?? "";
  const rows = leads.map((l) => {
    const fields: [string, Sourced | undefined][] = [["nazwa", l.official_name], ["adres", l.official_address], ["nip", l.nip], ["regon", l.regon], ["krs", l.krs],
      ["vat", l.vat_status], ["www", l.website], ["email", l.email], ["telefon", l.phone]];
    const sources = fields.filter(([, s]) => s).map(([k, s]) => `${k}: ${s!.source} ${s!.fetched_at.slice(0, 16)} ${s!.url}`).join(" | ");
    return [cell(l.official_name), cell(l.official_address), cell(l.nip), cell(l.regon), cell(l.krs), cell(l.vat_status), cell(l.website), cell(l.email), cell(l.phone),
      l.found_in.join(", "), l.place.place_id, l.place.maps_url, l.www_note ?? "", sources];
  });
  const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
  return "﻿" + [header, ...rows].map((r) => r.map(esc).join(";")).join("\r\n");
}
