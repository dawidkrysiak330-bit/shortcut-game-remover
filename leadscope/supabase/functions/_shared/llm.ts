// =============================================================
// Wywołanie Claude z twardą walidacją:
// - prompt systemowy zakazuje zgadywania,
// - odpowiedź musi być JSON-em zgodnym ze schematem zod,
// - niezgodne odpowiedzi są ODRZUCANE i logowane (llm_rejections).
// Model domyślny: claude-opus-5-5 (zmienisz sekretem ANTHROPIC_MODEL).
// =============================================================
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { extractJson } from "./core/schemas.ts";
import type { CostMeter } from "./costs.ts";

export const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-opus-5-5";

export const NO_GUESS_RULE =
  "Jeśli informacji nie ma w dostarczonych danych — wpisz BRAK DANYCH. Nie zgaduj. " +
  "Nie dopisuj faktów spoza danych (liczby pracowników, przychodów, klientów, certyfikatów itp.).";

const client = new Anthropic(); // klucz z sekretu ANTHROPIC_API_KEY

export type LlmResult<T> = { ok: true; data: T; raw: string } | { ok: false; raw: string; errors: string[] };

export async function callJson<T>(opts: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  meter: CostMeter;
  effort?: "low" | "medium" | "high";
}): Promise<LlmResult<T>> {
  // Beta endpoint tylko po to, by włączyć serwerowy fallback przy odmowie (refusal) modelu.
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: opts.effort ?? "low" },
    system: `${opts.system}\n\n${NO_GUESS_RULE}\nOdpowiadasz WYŁĄCZNIE jednym obiektem JSON, bez komentarzy.`,
    messages: [{ role: "user", content: opts.user }],
  } as never) as unknown as Anthropic.Message;

  // koszt tokenów
  await opts.meter.record("anthropic", MODEL, response.usage.input_tokens / 1e6, "mtok_in");
  await opts.meter.record("anthropic", MODEL, response.usage.output_tokens / 1e6, "mtok_out");

  const raw = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
  if (response.stop_reason === "refusal") return { ok: false, raw, errors: ["Model odmówił odpowiedzi (refusal)"] };
  if (response.stop_reason === "max_tokens") return { ok: false, raw, errors: ["Odpowiedź ucięta (max_tokens)"] };
  try {
    const parsed = opts.schema.safeParse(extractJson(raw));
    if (!parsed.success) return { ok: false, raw, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    return { ok: true, data: parsed.data, raw };
  } catch (e) {
    return { ok: false, raw, errors: [String(e)] };
  }
}
