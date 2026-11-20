// Krok 1: fraza → ICP. Krok 2: edycja ICP. Krok 3: kraj/region (+promień) → start, postęp, przerwanie.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AI_ENABLED, api, type SearchStatus } from "../lib/api";
import type { Icp, Scale } from "../../supabase/functions/_shared/core/types.ts";
import { IcpSchema } from "../../supabase/functions/_shared/core/schemas.ts";
import { REGIONS } from "../../supabase/functions/_shared/core/regions.ts";

const LIST_FIELDS: { key: keyof Icp; label: string; hint: string }[] = [
  { key: "buyer_industries", label: "Branże odbiorców", hint: "kto kupuje / wykorzystuje produkt" },
  { key: "pkd_codes", label: "Kody PKD 2007", hint: "format NN.NN.X — zweryfikuj w klasyfikacji GUS" },
  { key: "nace_codes", label: "Kody NACE Rev. 2", hint: "format NN.NN" },
  { key: "keywords", label: "Słowa kluczowe wyszukiwania", hint: "frazy wpisywane do Google Places (każda = osobne zapytanie)" },
  { key: "buying_signals", label: "Sygnały zakupowe na www", hint: "frazy na stronie firmy świadczące o potrzebie" },
  { key: "exclusion_signals", label: "Sygnały wykluczające", hint: "np. świadczące, że to konkurent" },
];
const SCALES: { v: Scale; label: string }[] = [
  { v: "micro", label: "mikro" }, { v: "small", label: "mała" }, { v: "medium", label: "średnia" }, { v: "large", label: "duża" },
];

export default function NewSearch() {
  const nav = useNavigate();
  const [phrase, setPhrase] = useState("");
  const [icp, setIcp] = useState<Icp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [regionCode, setRegionCode] = useState("");
  const [city, setCity] = useState("");
  const [radius, setRadius] = useState("");
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const searchId = useRef<string | null>(null);

  async function makeIcp() {
    if (!AI_ENABLED) {
      // Bez AI: pusty profil do wypełnienia przez handlowca (zero kosztów)
      setIcp({ product: phrase.trim(), buyer_industries: [], pkd_codes: [], nace_codes: [], keywords: [], buying_signals: [], exclusion_signals: [], target_scale: [] });
      return;
    }
    setBusy(true); setError(null);
    try { setIcp(await api.generateIcp(phrase)); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    setBusy(false);
  }

  function setList(key: keyof Icp, text: string) {
    setIcp((p) => p && { ...p, [key]: text.split("\n").map((s) => s.trim()).filter(Boolean) });
  }

  async function start() {
    setError(null);
    const parsed = IcpSchema.safeParse(icp);
    if (!parsed.success) { setError("Popraw ICP: " + parsed.error.issues.map((i) => `${i.path.join(".")} — ${i.message}`).join("; ")); return; }
    if (!regionCode) { setError("Wybierz region (filtr obowiązkowy)."); return; }
    if (radius && !city) { setError("Promień wymaga podania miasta."); return; }
    try {
      searchId.current = await api.startSearch({ icp: parsed.data, country: "PL", region_code: regionCode, city: city || undefined, radius_km: radius ? Number(radius) : undefined });
      setStatus({ id: searchId.current, status: "queued", progress: 0, message: "W kolejce…", cost_usd: 0, results_count: 0 });
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }

  // Pętla "ticków" — każde wywołanie przetwarza kolejną porcję pracy na serwerze.
  useEffect(() => {
    if (!status || ["done", "cancelled", "failed"].includes(status.status)) return;
    const t = setTimeout(async () => {
      try { setStatus(await api.tick(status.id)); } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    }, api.mode === "mock" ? 300 : 1500);
    return () => clearTimeout(t);
  }, [status]);

  useEffect(() => { if (status?.status === "done") nav(`/results/${status.id}`); }, [status, nav]);

  return (
    <div>
      <h1>Nowe wyszukiwanie</h1>
      <section className="card">
        <h2>1. Co sprzedaje Twoja firma?</h2>
        <div className="row">
          <input data-testid="phrase" placeholder="np. palety drewniane EPAL" value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          <button data-testid="gen-icp" disabled={busy || phrase.trim().length < 2} onClick={makeIcp}>{busy ? "Generuję…" : AI_ENABLED ? "Zaproponuj profil kupca (AI)" : "Utwórz profil kupca (ICP)"}</button>
        </div>
      </section>

      {icp && (
        <section className="card">
          <h2>2. Sprawdź i popraw profil kupca</h2>
          <p className="muted">{AI_ENABLED
            ? "To propozycja modelu AI — hipoteza, nie fakty. Popraw ją przed wyszukiwaniem (jedna pozycja w linii)."
            : "Wpisz, KTO kupuje Twój produkt (jedna pozycja w linii). Wymagane: co najmniej jedna branża odbiorców i jedno słowo kluczowe. Kody PKD sprawdzisz w klasyfikacji PKD 2007 (GUS)."}</p>
          <div className="grid2">
            {LIST_FIELDS.map((f) => (
              <label key={f.key}>{f.label} <span className="muted">({f.hint})</span>
                <textarea data-testid={`icp-${f.key}`} rows={4} value={(icp[f.key] as string[]).join("\n")} onChange={(e) => setList(f.key, e.target.value)} />
              </label>
            ))}
          </div>
          <fieldset><legend>Skala docelowych firm</legend>
            {SCALES.map((s) => (
              <label key={s.v} className="inline">
                <input type="checkbox" checked={icp.target_scale.includes(s.v)}
                  onChange={(e) => setIcp({ ...icp, target_scale: e.target.checked ? [...icp.target_scale, s.v] : icp.target_scale.filter((x) => x !== s.v) })} /> {s.label}
              </label>
            ))}
          </fieldset>
        </section>
      )}

      {icp && (
        <section className="card">
          <h2>3. Gdzie szukać?</h2>
          <div className="grid3">
            <label>Kraj *<select value="PL" disabled><option value="PL">Polska</option></select></label>
            <label>Województwo *
              <select data-testid="region" value={regionCode} onChange={(e) => setRegionCode(e.target.value)}>
                <option value="">— wybierz —</option>
                {REGIONS.map((r) => <option key={r.code} value={r.code}>{r.name} ({r.nuts2.join("/")})</option>)}
              </select>
            </label>
            <label>Miasto (opcjonalnie)<input value={city} onChange={(e) => setCity(e.target.value)} placeholder="np. Kraków" /></label>
            <label>Promień od miasta, km<input type="number" min={1} max={300} value={radius} onChange={(e) => setRadius(e.target.value)} /></label>
          </div>
          {!status && <button data-testid="start" onClick={start}>Szukaj firm</button>}
        </section>
      )}

      {status && (
        <section className="card" data-testid="progress">
          <h2>Postęp</h2>
          <div className="bar"><div style={{ width: `${status.progress}%` }} /></div>
          <p>{status.progress}% — {status.message} · koszt API: <b data-testid="cost">${Number(status.cost_usd).toFixed(4)}</b></p>
          {!["done", "cancelled", "failed"].includes(status.status) && (
            <button className="danger" onClick={() => api.cancel(status.id)}>Przerwij wyszukiwanie</button>
          )}
          {status.status === "failed" && <p className="error">Wyszukiwanie nie powiodło się: {status.message}</p>}
          {status.status === "cancelled" && <p>Przerwano. <button onClick={() => setStatus(null)}>Zacznij ponownie</button></p>}
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
