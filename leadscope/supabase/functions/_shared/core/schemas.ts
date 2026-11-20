// =============================================================
// Schematy zod dla odpowiedzi LLM + kontrola "ugruntowania":
// odpowiedź niezgodna ze schematem LUB zawierająca fakty spoza
// danych wejściowych jest ODRZUCANA i logowana (tabela llm_rejections).
// =============================================================
import { z } from "zod";
import type { FieldKey, MergedCompany } from "./types.ts";
import { normText } from "./normalize.ts";

export const BRAK = "BRAK DANYCH";
export const NO_DESCRIPTION = "Brak wystarczających danych do opisu";

const pkdRe = /^\d{2}\.\d{2}\.[A-Z]$/;
const naceRe = /^\d{2}\.\d{1,2}$/;
const phrase = z.string().trim().min(2).max(120);

export const IcpSchema = z.object({
  product: z.string().trim().min(2).max(200),
  buyer_industries: z.array(phrase).min(1).max(15),
  pkd_codes: z.array(z.string().regex(pkdRe, "PKD w formacie NN.NN.X")).max(30),
  nace_codes: z.array(z.string().regex(naceRe, "NACE w formacie NN.NN")).max(30),
  keywords: z.array(phrase).min(1).max(12),
  buying_signals: z.array(phrase).max(20),
  exclusion_signals: z.array(phrase).max(20),
  target_scale: z.array(z.enum(["micro", "small", "medium", "large"])).max(4),
});
export type IcpParsed = z.infer<typeof IcpSchema>;

const FIELD_KEYS = [
  "name", "nip", "regon", "krs", "legal_form", "status", "vat_status", "registration_date", "address",
  "postal_code", "city", "region", "website", "phone", "email", "pkd", "description_text", "types", "business_status", "lat", "lng",
] as const;

export const LeadCardLlmSchema = z.object({
  description: z.string().trim().min(3).max(600),
  why_buy: z.array(z.object({
    point: z.string().trim().min(5).max(300),
    // na jakie pole danych powołuje się punkt — musi istnieć w danych firmy
    evidence_field: z.enum([...FIELD_KEYS, "website_text"]),
  })).min(0).max(3),
  talk_angle: z.string().trim().min(3).max(400),
  opening_questions: z.array(z.string().trim().min(5).max(250)).max(3),
});
export type LeadCardLlm = z.infer<typeof LeadCardLlmSchema>;

/** Wyciąga obiekt JSON z tekstu odpowiedzi modelu. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Brak obiektu JSON w odpowiedzi");
  return JSON.parse(text.slice(start, end + 1));
}

function countSentences(s: string): number {
  return s.split(/[.!?]+(\s|$)/).filter((x) => x.trim().length > 2).length;
}

/** Cały tekst faktów, który dostał model — do kontroli ugruntowania. */
export function factsCorpus(c: MergedCompany): string {
  const parts: string[] = [];
  for (const list of Object.values(c.fields)) for (const fv of list ?? []) parts.push(Array.isArray(fv.value) ? fv.value.join(" ") : fv.value);
  for (const p of c.website_pages) parts.push(p.text);
  return normText(parts.join(" \n "));
}

/**
 * Kontrola ugruntowania (heurystyczna, ale twarda):
 * 1) opis max 3 zdania,
 * 2) każda liczba (≥2 cyfry) z opisu/punktów musi występować w danych,
 * 3) każdy punkt "dlaczego" wskazuje pole, które firma faktycznie ma.
 * Zwraca listę błędów (pusta = OK).
 */
export function groundingErrors(card: LeadCardLlm, c: MergedCompany, product: string): string[] {
  const errors: string[] = [];
  const corpus = factsCorpus(c) + " " + normText(product);
  // korpus bez separatorów, żeby "123 456 789" == "123-456-789"
  const corpusDigits = corpus.replace(/[\s.,\-()/]/g, "");
  if (card.description !== NO_DESCRIPTION && countSentences(card.description) > 3) errors.push("Opis ma więcej niż 3 zdania");
  const texts = [card.description, card.talk_angle, ...card.why_buy.map((w) => w.point)];
  for (const t of texts) {
    for (const num of t.match(/\d[\d\s.,\-]*\d/g) ?? []) {
      const digits = num.replace(/\D/g, "");
      if (digits.length >= 2 && !corpusDigits.includes(digits)) {
        errors.push(`Liczba „${num}” nie występuje w danych źródłowych`);
      }
    }
  }
  for (const w of card.why_buy) {
    if (w.evidence_field === "website_text") {
      if (c.website_pages.length === 0) errors.push("Punkt powołuje się na www, a brak treści www");
    } else if (!c.fields[w.evidence_field as FieldKey]?.length) {
      errors.push(`Punkt powołuje się na brakujące pole „${w.evidence_field}”`);
    }
  }
  return errors;
}

/** Karta awaryjna, gdy LLM zwrócił niepoprawną odpowiedź — nic nie zgadujemy. */
export function fallbackCard(): LeadCardLlm {
  return { description: NO_DESCRIPTION, why_buy: [], talk_angle: BRAK, opening_questions: [] };
}
