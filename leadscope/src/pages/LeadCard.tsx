// Karta leada dla handlowca. PDF: przycisk "Drukuj / PDF" (przeglądarka → Zapisz jako PDF).
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AI_ENABLED, api, type Card, type LeadRow } from "../lib/api";
import { buildCard } from "../../supabase/functions/_shared/core/card.ts";
import type { ComponentKey, FieldKey, FieldValue } from "../../supabase/functions/_shared/core/types.ts";
import { comparable } from "../../supabase/functions/_shared/core/dedup.ts";
import { BRAK, NO_DESCRIPTION } from "../../supabase/functions/_shared/core/schemas.ts";

const SOURCE_LABEL: Record<string, string> = {
  google_places: "Google Maps", gus_bir: "GUS REGON (BIR)", krs: "KRS", ceidg: "CEIDG",
  biala_lista: "Biała lista VAT", vies: "VIES", website: "Strona www firmy", user: "Użytkownik",
};
const COMPONENT_LABEL: Record<ComponentKey, string> = {
  industry: "Dopasowanie branży", buying_signals: "Sygnały zakupowe (www)", scale: "Skala",
  location: "Lokalizacja / logistyka", activity: "Aktywność firmy", contact: "Firmowy kanał kontaktu",
};
const BASIC: { key: FieldKey; label: string }[] = [
  { key: "nip", label: "NIP" }, { key: "regon", label: "REGON" }, { key: "krs", label: "KRS" },
  { key: "legal_form", label: "Forma prawna" }, { key: "status", label: "Status" }, { key: "vat_status", label: "Status VAT" },
  { key: "registration_date", label: "Data rejestracji" }, { key: "address", label: "Adres" }, { key: "region", label: "Region" },
  { key: "website", label: "WWW" }, { key: "phone", label: "Telefon firmowy" }, { key: "email", label: "E-mail firmowy" },
  { key: "pkd", label: "PKD" },
];

function show(v: FieldValue["value"]) { return Array.isArray(v) ? v.join(", ") : v; }

/** Wartość + oznaczenie: [BRAK DANYCH] gdy brak, [NIEPEWNE] gdy źródła podają różne wartości. */
function FieldCell({ k, list }: { k: FieldKey; list?: FieldValue[] }) {
  if (!list?.length) return <span className="flag">[BRAK DANYCH]</span>;
  const distinct = new Set(list.map((fv) => (Array.isArray(fv.value) ? fv.value.join(",") : comparable(k, fv.value))));
  return (
    <>
      {show(list[0].value)} <span className="muted small">({SOURCE_LABEL[list[0].source]})</span>
      {distinct.size > 1 && <span className="flag" title={list.map((fv) => `${SOURCE_LABEL[fv.source]}: ${show(fv.value)}`).join("\n")}> [NIEPEWNE]</span>}
    </>
  );
}

export default function LeadCard() {
  const { leadId } = useParams();
  const [lead, setLead] = useState<LeadRow | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Bez AI karta powstaje regułami, wyłącznie z zebranych danych (bez kosztów).
    api.getLead(leadId!).then((l) => { setLead(l); setCard(l.card ?? (AI_ENABLED ? null : buildCard(l.company, l.score, l.product))); }).catch((e) => setError(String(e.message ?? e)));
  }, [leadId]);

  async function gen() {
    setBusy(true); setError(null);
    try { setCard(await api.generateCard(leadId!)); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    setBusy(false);
  }
  async function refreshGoogle() {
    const places = await api.refreshPlaces(leadId!);
    if (places && lead) {
      const fields = { ...lead.company.fields } as Record<string, FieldValue[]>;
      for (const [k, v] of Object.entries(places)) fields[k] = [...(fields[k] ?? []).filter((x) => x.source !== "google_places"), ...v];
      setLead({ ...lead, places_expired: false, company: { ...lead.company, fields } });
    }
  }

  if (error && !lead) return <p className="error">{error}</p>;
  if (!lead) return <p>Ładowanie…</p>;
  const f = lead.company.fields;
  const s = lead.score;
  const allFields = Object.entries(f) as [FieldKey, FieldValue[]][];

  return (
    <article className="lead-card" data-testid="lead-card">
      <div className="row no-print">
        <button onClick={() => window.print()}>Drukuj / zapisz PDF</button>
        {AI_ENABLED && <button data-testid="gen-card" disabled={busy} onClick={gen}>{busy ? "Generuję…" : card ? "Wygeneruj kartę ponownie" : "Wygeneruj opis i kąt rozmowy (AI)"}</button>}
        {lead.places_expired && <button className="secondary" onClick={refreshGoogle}>Odśwież dane Google</button>}
      </div>

      <div className="warning" data-testid="consent-warning">
        ⚠️ Aplikacja nie wysyła e-maili ani nie dzwoni. <b>Pierwszy kontakt marketingowy e-mailem lub telefonem wymaga uprzedniej zgody odbiorcy</b>
        {" "}(art. 398 Prawa komunikacji elektronicznej) — dotyczy to także firm (B2B).
      </div>
      {lead.is_natural_person && (
        <div className="warning">
          ℹ️ To jednoosobowa działalność (JDG) — dane są danymi osobowymi (RODO). Używaj ich tylko w celu kontaktu B2B, spełnij obowiązek informacyjny z art. 14 RODO
          (szablon: docs/RODO_art14_szablon.md) i uwzględniaj sprzeciw/żądanie usunięcia.
        </div>
      )}

      <h1>{f.name?.[0] ? show(f.name[0].value) : "[BRAK DANYCH]"}</h1>
      <div className="score-box">
        <div className="score" data-testid="score">{s.total}%</div>
        <div>Pewność danych: <b>{s.confidence}</b> <span className="muted small">(pola potwierdzone w ≥2 źródłach: {s.confirmed_fields.join(", ") || "brak"})</span></div>
      </div>
      {s.excluded && <p className="error">Wykluczony: {s.exclusion_reason}</p>}
      <p><i>{s.justification}</i></p>

      <h2>Dane firmy</h2>
      <table><tbody>
        {BASIC.map((b) => <tr key={b.key}><th>{b.label}</th><td><FieldCell k={b.key} list={f[b.key]} /></td></tr>)}
      </tbody></table>

      <h2>Czym się zajmuje</h2>
      <p data-testid="description">{card ? card.description : f.description_text ? show(f.description_text[0].value) + " (z rejestru)" : NO_DESCRIPTION}</p>

      <h2>Dlaczego może kupić: {lead.product}</h2>
      {card && card.why_buy.length > 0 ? (
        <ul>{card.why_buy.map((w, i) => <li key={i}>{w.point} <span className="muted small">[źródło: {w.evidence_field === "website_text" ? "strona www" : w.evidence_field}]</span></li>)}</ul>
      ) : (
        <ul>
          {(Object.keys(s.components) as ComponentKey[]).filter((k) => s.components[k].points > 0).slice(0, 3).map((k) => (
            <li key={k}>{s.components[k].reason} <span className="muted small">[źródło: {s.components[k].evidence[0] ? SOURCE_LABEL[s.components[k].evidence[0].source] : BRAK}]</span></li>
          ))}
        </ul>
      )}
      {card?.rejected_reasons && card.rejected_reasons.length > 0 && (
        <p className="muted small">Odpowiedź AI odrzucona (niezgodna z danymi): {card.rejected_reasons.join("; ")}. Pokazano tylko dane pewne.</p>
      )}

      <h2>Score — składowe</h2>
      <table data-testid="components"><thead><tr><th>Składowa</th><th>Punkty</th><th>Powód</th><th>Dowód</th></tr></thead><tbody>
        {(Object.keys(s.components) as ComponentKey[]).map((k) => {
          const c = s.components[k];
          return (
            <tr key={k}>
              <td>{COMPONENT_LABEL[k]}</td>
              <td>{c.points}/{c.max}</td>
              <td>{c.reason} {c.flags.map((fl) => <span key={fl} className="flag">[{fl}]</span>)}</td>
              <td className="small">{c.evidence.slice(0, 2).map((e, i) => (
                <div key={i}>{SOURCE_LABEL[e.source]}{e.source_url && <> — <a href={e.source_url} target="_blank" rel="noreferrer">link</a></>} ({e.fetched_at.slice(0, 10)}): {e.snippet.slice(0, 140)}</div>
              ))}</td>
            </tr>
          );
        })}
      </tbody></table>

      <h2>Kąt rozmowy</h2>
      <p>{card ? card.talk_angle : <span className="flag">[BRAK DANYCH] — wygeneruj kartę</span>}</p>
      {card && card.opening_questions.length > 0 && (<><h3>Pytania otwierające</h3><ol>{card.opening_questions.map((q, i) => <li key={i}>{q}</li>)}</ol></>)}

      <h2>Źródła (każde pole)</h2>
      <table data-testid="sources" className="small"><thead><tr><th>Pole</th><th>Wartość</th><th>Źródło</th><th>Pobrano</th></tr></thead><tbody>
        {allFields.flatMap(([k, list]) => list.map((fv, i) => (
          <tr key={`${k}-${i}`}><td>{k}</td><td>{show(fv.value)}</td>
            <td>{fv.source_url ? <a href={fv.source_url} target="_blank" rel="noreferrer">{SOURCE_LABEL[fv.source]}</a> : SOURCE_LABEL[fv.source]}</td>
            <td>{fv.fetched_at.slice(0, 16).replace("T", " ")}</td></tr>
        )))}
        {lead.company.website_pages.map((p) => <tr key={p.url}><td>treść www</td><td>{p.text.slice(0, 80)}…</td><td><a href={p.url} target="_blank" rel="noreferrer">{p.url}</a></td><td>{p.fetched_at.slice(0, 16).replace("T", " ")}</td></tr>)}
      </tbody></table>
      {lead.place_id && <p className="attribution">Dane oznaczone „Google Maps”: © Google Maps{lead.places_expired ? " — wygasły, kliknij „Odśwież dane Google”" : ""}</p>}
      {error && <p className="error">{error}</p>}
    </article>
  );
}
