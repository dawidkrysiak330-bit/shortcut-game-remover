// =============================================================
// Karta leada BEZ AI — budowana regułami wyłącznie z zebranych danych:
// - opis: przedmiot działalności z KRS albo dosłowne zdania ze strony "o nas",
// - "dlaczego może kupić": powody ze składowych scoringu (z dowodem),
// - kąt rozmowy i pytania: szablony wypełnione danymi.
// Zero kosztów, zero ryzyka zmyślonych faktów.
// =============================================================
import type { ComponentKey, MergedCompany, ScoreResult } from "./types.ts";
import { BRAK, NO_DESCRIPTION, type LeadCardLlm } from "./schemas.ts";

type WhyField = LeadCardLlm["why_buy"][number]["evidence_field"];

/** Zdania "wyglądające na treść" (nie menu): 6–60 słów, zakończone kropką. */
export function contentSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /[.!?]$/.test(s) && s.split(/\s+/).length >= 6 && s.split(/\s+/).length <= 60 && !/@|cookies|polityk[aię] prywatności|©/i.test(s));
}

export function buildDescription(c: MergedCompany): string {
  const krs = c.fields.description_text?.[0];
  if (krs) {
    const v = Array.isArray(krs.value) ? krs.value.join("; ") : krs.value;
    return `Przedmiot przeważającej działalności (rejestr): ${v}.`;
  }
  const pages = [...c.website_pages].sort((a, b) => Number(/o-nas|about|o-firmie|firma/i.test(b.url)) - Number(/o-nas|about|o-firmie|firma/i.test(a.url)));
  for (const p of pages) {
    const sentences = contentSentences(p.text).slice(0, 3);
    if (sentences.length) return `Ze strony firmy: „${sentences.join(" ")}”`;
  }
  return NO_DESCRIPTION;
}

const FIELD_FOR: Record<ComponentKey, WhyField> = {
  industry: "pkd", buying_signals: "website_text", scale: "legal_form",
  location: "region", activity: "status", contact: "phone",
};

export function buildCard(c: MergedCompany, s: ScoreResult, product: string): LeadCardLlm {
  const order: ComponentKey[] = ["buying_signals", "industry", "scale", "activity", "location", "contact"];
  const why_buy = order
    .filter((k) => s.components[k].points > 0 && s.components[k].evidence.length > 0)
    .slice(0, 3)
    .map((k) => {
      const ev = s.components[k].evidence[0];
      const field: WhyField = ev.field === "website_text" ? "website_text" : (c.fields[ev.field]?.length ? (ev.field as WhyField) : FIELD_FOR[k]);
      return { point: `${s.components[k].reason} Dowód: ${ev.snippet.slice(0, 160)}`, evidence_field: field };
    })
    .filter((w) => w.evidence_field === "website_text" ? c.website_pages.length > 0 : !!c.fields[w.evidence_field as keyof typeof c.fields]?.length);

  const signal = s.components.buying_signals.evidence[0];
  const pkd = c.fields.pkd?.[0];
  const talk_angle = signal
    ? `Na stronie firmy pojawia się fragment: ${signal.snippet.slice(0, 160)} — nawiąż do niego i zapytaj, jak dziś rozwiązują temat: ${product}.`
    : pkd
      ? `Firma działa wg PKD ${Array.isArray(pkd.value) ? pkd.value[0] : pkd.value} — zapytaj, czy i jak wykorzystuje: ${product}.`
      : BRAK;

  return {
    description: buildDescription(c),
    why_buy,
    talk_angle,
    opening_questions: [
      `Jak dziś wygląda u Państwa zaopatrzenie w: ${product}?`,
      "Kto u Państwa odpowiada za wybór dostawców w tym obszarze?",
      "Co musiałoby się zmienić, żeby rozważyli Państwo nowego dostawcę?",
    ],
  };
}
