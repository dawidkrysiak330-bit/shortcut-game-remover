// =============================================================
// Strona www firmy: główna + (o nas, oferta, kontakt).
// Zasady: robots.txt respektowany, jawny User-Agent, max 4 strony/domenę,
// 1 zapytanie na 1,5 s na domenę, limit rozmiaru, bez logowań/CAPTCHA/paywalli.
// Zbieramy tylko dane firmowe: NIP, adres rolowy (biuro@), telefon ze strony kontaktowej.
// =============================================================
import type { RawCompany, WebsitePage } from "../core/types.ts";
import { extractGenericEmails, extractNips, extractPhones } from "../core/normalize.ts";
import { htmlToText, isAllowedByRobots, pickSubpages } from "../core/web.ts";
import type { AdapterContext } from "./types.ts";
import { fetchWithTimeout, nowIso } from "./types.ts";

const UA = `LeadScopeBot/0.1 (+${Deno.env.get("BOT_INFO_URL") ?? "https://example.com/bot"})`;
const MAX_BYTES = 600_000;
const DELAY_MS = 1500;
const MAX_TEXT = 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string): Promise<{ ok: boolean; html: string; blocked: boolean }> {
  try {
    const res = await fetchWithTimeout(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" }, 10_000);
    // 401/403/429 → nie próbujemy obchodzić (logowanie, blokada, limit)
    if ([401, 403, 429].includes(res.status)) return { ok: false, html: "", blocked: true };
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) return { ok: false, html: "", blocked: false };
    const html = (await res.text()).slice(0, MAX_BYTES);
    // prosta detekcja CAPTCHA — jeśli jest, rezygnujemy
    if (/captcha|cf-challenge|g-recaptcha/i.test(html) && html.length < 20_000) return { ok: false, html: "", blocked: true };
    return { ok: true, html, blocked: false };
  } catch {
    return { ok: false, html: "", blocked: false };
  }
}

export async function crawlWebsite(website: string, ctx: AdapterContext): Promise<{ pages: WebsitePage[]; records: RawCompany[] }> {
  let base: URL;
  try { base = new URL(website.includes("://") ? website : `https://${website}`); } catch { return { pages: [], records: [] }; }
  // robots.txt — jeśli brak pliku, obowiązują ogólne zasady (pobieramy ostrożnie)
  let robots: string | null = null;
  try {
    const r = await fetchWithTimeout(new URL("/robots.txt", base).href, { headers: { "User-Agent": UA } }, 8000);
    robots = r.ok ? await r.text() : null;
  } catch { robots = null; }
  const pages: WebsitePage[] = [];
  const records: RawCompany[] = [];
  const queue = [base.href];
  const visited = new Set<string>();
  while (queue.length && pages.length < 4) {
    if (await ctx.cancelled()) break;
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);
    if (!isAllowedByRobots(robots, UA, new URL(url).pathname)) continue;
    if (pages.length > 0) await sleep(DELAY_MS);
    const r = await get(url);
    await ctx.meter.record("website", "page", 1);
    if (r.blocked) break;
    if (!r.ok) continue;
    const text = htmlToText(r.html).slice(0, MAX_TEXT);
    const fetched_at = nowIso();
    pages.push({ url, text, fetched_at });
    if (pages.length === 1) queue.push(...pickSubpages(r.html, url));
    const isContact = /kontakt|contact/i.test(url) || pages.length === 1;
    records.push({
      source: "website", source_url: url, fetched_at,
      fields: {
        website: base.origin,
        nip: extractNips(text)[0],
        email: isContact ? extractGenericEmails(text)[0] : undefined,
        phone: /kontakt|contact/i.test(url) ? extractPhones(text)[0] : undefined,
      },
    });
  }
  return { pages, records };
}
