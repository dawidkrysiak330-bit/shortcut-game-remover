// =============================================================
// Scoring 0–100% — w pełni deterministyczny (bez LLM), więc
// każde uzasadnienie pochodzi WYŁĄCZNIE z zebranych danych.
// Wagi przychodzą z tabeli konfiguracyjnej `scoring_weights`.
// =============================================================
import type {
  ComponentKey, ComponentScore, Confidence, Evidence, FieldKey, Icp, MergedCompany,
  Scale, ScoreResult, SearchContext, Weights,
} from "./types.ts";
import { comparable } from "./dedup.ts";
import { haversineKm, isGenericEmail, normalizePkd, normText } from "./normalize.ts";

const asList = (v: string | string[]) => (Array.isArray(v) ? v : [v]);

function allValues(c: MergedCompany, key: FieldKey): { value: string; ev: Evidence }[] {
  return (c.fields[key] ?? []).flatMap((fv) =>
    asList(fv.value).map((value) => ({
      value,
      ev: { field: key, source: fv.source, source_url: fv.source_url, fetched_at: fv.fetched_at, snippet: value },
    }))
  );
}

/** Szuka frazy w tekstach stron www; zwraca dowód z fragmentem. */
function findOnWebsite(c: MergedCompany, phrase: string): Evidence | null {
  const p = normText(phrase);
  if (p.length < 3) return null;
  for (const page of c.website_pages) {
    const t = normText(page.text);
    const i = t.indexOf(p);
    if (i >= 0) {
      return {
        field: "website_text", source: "website", source_url: page.url, fetched_at: page.fetched_at,
        snippet: "…" + t.slice(Math.max(0, i - 60), i + p.length + 60) + "…",
      };
    }
  }
  return null;
}

function comp(max: number, ratio: number, reason: string, evidence: Evidence[] = [], flags: ComponentScore["flags"] = []): ComponentScore {
  const r = Math.max(0, Math.min(1, ratio));
  return { points: Math.round(max * r * 10) / 10, max, reason, evidence, flags };
}

// ---------- składowe ----------

export function scoreIndustry(c: MergedCompany, icp: Icp, max: number): ComponentScore {
  const pkd = allValues(c, "pkd");
  if (pkd.length > 0 && icp.pkd_codes.length > 0) {
    let best = 0;
    let bestEv: Evidence | null = null;
    let bestLabel = "";
    for (const { value, ev } of pkd) {
      const a = normalizePkd(value);
      for (const target of icp.pkd_codes) {
        const b = normalizePkd(target);
        const s = a === b ? 1 : a.slice(0, 4) === b.slice(0, 4) ? 0.8 : a.slice(0, 2) === b.slice(0, 2) ? 0.5 : 0;
        if (s > best) { best = s; bestEv = ev; bestLabel = `${value} ~ ${target}`; }
      }
    }
    if (best > 0) {
      return comp(max, best, `PKD z rejestru pasuje do ICP (${bestLabel}).`, bestEv ? [bestEv] : []);
    }
    return comp(max, 0, `PKD z rejestru (${pkd.map((p) => p.value).slice(0, 3).join(", ")}) nie pasuje do PKD z ICP.`, pkd.slice(0, 1).map((p) => p.ev));
  }
  // Brak PKD z rejestru → dopasowanie słownikowe (słabsze, oznaczone NIEPEWNE)
  const phrases = [...icp.buyer_industries, ...icp.keywords];
  const ev: Evidence[] = [];
  for (const ph of phrases) {
    const p = normText(ph);
    const hit = [...allValues(c, "name"), ...allValues(c, "types"), ...allValues(c, "description_text")]
      .find((x) => normText(x.value).includes(p));
    if (hit) ev.push({ ...hit.ev, snippet: `${hit.value} (fraza: ${ph})` });
    else { const w = findOnWebsite(c, ph); if (w) ev.push(w); }
    if (ev.length >= 2) break;
  }
  if (ev.length === 0) return comp(max, 0, "Brak PKD z rejestru i brak słów kluczowych branży w danych.", [], ["BRAK DANYCH"]);
  return comp(max, ev.length >= 2 ? 0.6 : 0.4, `Brak PKD z rejestru; znaleziono ${ev.length} fraz(y) branżowe w danych.`, ev, ["NIEPEWNE"]);
}

export function scoreBuyingSignals(c: MergedCompany, icp: Icp, max: number): ComponentScore {
  if (c.website_pages.length === 0) return comp(max, 0, "Brak treści strony www do analizy.", [], ["BRAK DANYCH"]);
  const ev = icp.buying_signals.map((s) => findOnWebsite(c, s)).filter((e): e is Evidence => !!e);
  const ratio = ev.length >= 2 ? 1 : ev.length === 1 ? 0.6 : 0;
  const reason = ev.length === 0
    ? "Na stronie www nie znaleziono sygnałów zakupowych z ICP."
    : `Na stronie www znaleziono ${ev.length} sygnał(y) zakupowe.`;
  return comp(max, ratio, reason, ev.slice(0, 3));
}

/** Szacunek skali z formy prawnej — to przybliżenie, zawsze oznaczane NIEPEWNE. */
export function scaleFromLegalForm(form: string): Scale[] | null {
  const f = normText(form);
  if (/osoba fizyczna|dzialalnosc gospodarcza|jdg/.test(f)) return ["micro"];
  if (/spolka cywilna/.test(f)) return ["micro", "small"];
  if (/akcyjna|s\.a\./.test(f)) return ["medium", "large"];
  if (/ograniczona|komandytowa|jawna|partnerska|sp\. z o\.o\./.test(f)) return ["small", "medium"];
  return null;
}

const SCALE_ORDER: Scale[] = ["micro", "small", "medium", "large"];

export function scoreScale(c: MergedCompany, icp: Icp, max: number, unknownFactor: number): ComponentScore {
  if (icp.target_scale.length === 0) return comp(max, 1, "ICP nie zawęża skali firmy.");
  const lf = allValues(c, "legal_form")[0];
  const est = lf ? scaleFromLegalForm(lf.value) : null;
  if (!lf || !est) return comp(max, unknownFactor, "Brak danych o skali firmy — przyznano punkty częściowe.", [], ["NIEPEWNE", "BRAK DANYCH"]);
  if (est.some((s) => icp.target_scale.includes(s))) {
    return comp(max, 1, `Forma prawna „${lf.value}” sugeruje skalę zgodną z ICP (szacunek).`, [lf.ev], ["NIEPEWNE"]);
  }
  const dist = Math.min(...est.flatMap((s) => icp.target_scale.map((t) => Math.abs(SCALE_ORDER.indexOf(s) - SCALE_ORDER.indexOf(t)))));
  return comp(max, dist === 1 ? 0.5 : 0, `Forma prawna „${lf.value}” sugeruje inną skalę niż w ICP (szacunek).`, [lf.ev], ["NIEPEWNE"]);
}

export function scoreLocation(c: MergedCompany, ctx: SearchContext, max: number): ComponentScore {
  const region = allValues(c, "region")[0];
  const inRegion = region ? normText(region.value).includes(normText(ctx.region_name)) : false;
  const lat = allValues(c, "lat")[0];
  const lng = allValues(c, "lng")[0];
  if (ctx.center && ctx.radius_km && lat && lng) {
    const d = haversineKm(ctx.center, { lat: Number(lat.value), lng: Number(lng.value) });
    const ratio = d <= ctx.radius_km ? 1 - 0.5 * (d / ctx.radius_km) : 0.2;
    return comp(max, ratio, `Odległość od wybranego miasta: ${d.toFixed(0)} km (promień ${ctx.radius_km} km).`, [lat.ev]);
  }
  if (!region) return comp(max, 0, "Brak danych o województwie firmy.", [], ["BRAK DANYCH"]);
  return comp(max, inRegion ? 1 : 0.2, inRegion ? `Siedziba w wybranym regionie (${region.value}).` : `Siedziba poza wybranym regionem (${region.value}).`, [region.ev]);
}

export function scoreActivity(c: MergedCompany, max: number): ComponentScore {
  let ratio = 0;
  const ev: Evidence[] = [];
  const parts: string[] = [];
  const status = [...allValues(c, "status"), ...allValues(c, "vat_status")].find((s) => /aktywn|czynny|active/.test(normText(s.value)));
  if (status) { ratio += 0.6; ev.push(status.ev); parts.push(`status w rejestrze: ${status.value}`); }
  const bs = allValues(c, "business_status").find((s) => s.value === "OPERATIONAL");
  if (bs) { ratio += 0.2; ev.push(bs.ev); parts.push("działa wg Google"); }
  if (c.website_pages.length > 0) {
    ratio += 0.2;
    const p = c.website_pages[0];
    ev.push({ field: "website_text", source: "website", source_url: p.url, fetched_at: p.fetched_at, snippet: "strona www odpowiada" });
    parts.push("strona www działa");
  }
  if (parts.length === 0) return comp(max, 0, "Brak danych potwierdzających aktywność firmy.", [], ["BRAK DANYCH"]);
  return comp(max, ratio, `Aktywność: ${parts.join(", ")}.`, ev, status ? [] : ["NIEPEWNE"]);
}

export function scoreContact(c: MergedCompany, max: number): ComponentScore {
  const phone = allValues(c, "phone")[0];
  const email = allValues(c, "email").find((e) => isGenericEmail(e.value));
  const ev = [phone?.ev, email?.ev].filter((e): e is Evidence => !!e);
  const ratio = (phone ? 0.5 : 0) + (email ? 0.5 : 0);
  if (ratio === 0) return comp(max, 0, "Brak publicznego firmowego telefonu i e-maila.", [], ["BRAK DANYCH"]);
  return comp(max, ratio, `Dostępny firmowy kanał: ${[phone && "telefon", email && "e-mail"].filter(Boolean).join(" i ")}.`, ev);
}

// ---------- wykluczenia ----------

export function checkExclusion(c: MergedCompany, icp: Icp): string | null {
  const status = [...allValues(c, "status"), ...allValues(c, "business_status")];
  const dead = status.find((s) => /wykresl|zlikwid|upadlos|zakonczon|zawieszon|closed_permanently/.test(normText(s.value)));
  if (dead) return `Firma nieaktywna: „${dead.value}” (źródło: ${dead.ev.source}).`;
  for (const sig of icp.exclusion_signals) {
    const name = allValues(c, "name").find((n) => normText(n.value).includes(normText(sig)));
    if (name) return `Sygnał wykluczający „${sig}” w nazwie (źródło: ${name.ev.source}).`;
    const w = findOnWebsite(c, sig);
    if (w) return `Sygnał wykluczający „${sig}” na stronie ${w.source_url}.`;
  }
  return null;
}

// ---------- pewność danych ----------

const CONFIDENCE_FIELDS: FieldKey[] = ["name", "nip", "postal_code", "phone", "website", "legal_form", "status", "city"];

/** Pole potwierdzone = ta sama (znormalizowana) wartość w ≥2 niezależnych źródłach. */
export function confirmedFields(c: MergedCompany): FieldKey[] {
  return CONFIDENCE_FIELDS.filter((key) => {
    const bySig = new Map<string, Set<string>>();
    for (const fv of c.fields[key] ?? []) {
      for (const v of asList(fv.value)) {
        const sig = comparable(key, v);
        if (!bySig.has(sig)) bySig.set(sig, new Set());
        bySig.get(sig)!.add(fv.source);
      }
    }
    return [...bySig.values()].some((s) => s.size >= 2);
  });
}

export function confidenceLevel(n: number): Confidence {
  return n >= 4 ? "Wysoka" : n >= 2 ? "Średnia" : "Niska";
}

// ---------- główna funkcja ----------

const LABELS: Record<ComponentKey, string> = {
  industry: "branża", buying_signals: "sygnały zakupowe", scale: "skala",
  location: "lokalizacja", activity: "aktywność", contact: "kontakt",
};

export function scoreCompany(c: MergedCompany, icp: Icp, ctx: SearchContext, w: Weights): ScoreResult {
  const components: Record<ComponentKey, ComponentScore> = {
    industry: scoreIndustry(c, icp, w.industry),
    buying_signals: scoreBuyingSignals(c, icp, w.buying_signals),
    scale: scoreScale(c, icp, w.scale, w.unknown_scale_factor),
    location: scoreLocation(c, ctx, w.location),
    activity: scoreActivity(c, w.activity),
    contact: scoreContact(c, w.contact),
  };
  const confirmed = confirmedFields(c);
  const confidence = confidenceLevel(confirmed.length);
  const exclusion = checkExclusion(c, icp);
  if (exclusion) {
    return { total: 0, components, excluded: true, exclusion_reason: exclusion, confidence, confirmed_fields: confirmed, justification: `0% — ${exclusion}` };
  }
  const total = Math.round(Object.values(components).reduce((s, x) => s + x.points, 0));
  // Uzasadnienie: dwie najmocniejsze i najsłabsza składowa — tylko z powodów wyliczonych powyżej.
  const sorted = (Object.keys(components) as ComponentKey[]).sort((a, b) => components[b].points / components[b].max - components[a].points / components[a].max);
  const top = sorted.slice(0, 2).map((k) => `${LABELS[k]}: ${components[k].reason}`).join(" ");
  const weakest = sorted[sorted.length - 1];
  const justification = `${top} Najsłabiej: ${LABELS[weakest]} — ${components[weakest].reason}`;
  return { total: Math.min(100, total), components, excluded: false, confidence, confirmed_fields: confirmed, justification };
}

/** Sprawdza, czy wagi sumują się do 100 (ten sam warunek jest w CHECK w bazie). */
export function validateWeights(w: Weights): boolean {
  return w.industry + w.buying_signals + w.scale + w.location + w.activity + w.contact === 100;
}
