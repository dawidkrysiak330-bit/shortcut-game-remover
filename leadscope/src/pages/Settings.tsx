// Ustawienia: wagi scoringu (tabela konfiguracyjna), koszty API i limity planu, RODO.
import { useEffect, useState } from "react";
import { api, type UsageInfo } from "../lib/api";
import type { Weights } from "../../supabase/functions/_shared/core/types.ts";
import { validateWeights } from "../../supabase/functions/_shared/core/scoring.ts";

const LABELS: [keyof Weights, string][] = [
  ["industry", "Dopasowanie branży"], ["buying_signals", "Sygnały zakupowe na www"], ["scale", "Skala"],
  ["location", "Lokalizacja/logistyka"], ["activity", "Aktywność firmy"], ["contact", "Kanał kontaktu"],
];

export default function Settings() {
  const [w, setW] = useState<Weights | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [nip, setNip] = useState("");
  const [domain, setDomain] = useState("");

  useEffect(() => { api.getWeights().then(setW); api.usage().then(setUsage); }, []);
  if (!w) return <p>Ładowanie…</p>;
  const sum = LABELS.reduce((a, [k]) => a + Number(w[k]), 0);

  return (
    <div>
      <h1>Ustawienia</h1>
      <section className="card">
        <h2>Koszty API i limity planu</h2>
        {usage && (<>
          <p>Plan: <b>{usage.plan}</b> · wyszukiwania w tym miesiącu: <b>{usage.searches_this_month}/{usage.max_searches}</b> · koszt w tym miesiącu: <b data-testid="month-cost">${usage.cost_this_month_usd.toFixed(4)}</b></p>
          {usage.unverified_prices.length > 0 && <p className="warning small">Ceny niezweryfikowane (liczone jako $0 — uzupełnij tabelę source_pricing wg oficjalnych cenników): {usage.unverified_prices.join(", ")}</p>}
          <table className="small"><thead><tr><th>Wyszukiwanie</th><th>Status</th><th>Wyniki</th><th>Koszt</th></tr></thead><tbody>
            {usage.per_search.map((s) => <tr key={s.id}><td>{new Date(s.created_at).toLocaleString("pl-PL")}</td><td>{s.status}</td><td>{s.results_count}</td><td>${s.cost_usd.toFixed(4)}</td></tr>)}
          </tbody></table>
        </>)}
      </section>

      <section className="card">
        <h2>Wagi scoringu (suma = 100)</h2>
        <div className="grid3">
          {LABELS.map(([k, label]) => (
            <label key={k}>{label}<input type="number" min={0} max={100} value={w[k]} onChange={(e) => setW({ ...w, [k]: Number(e.target.value) })} /></label>
          ))}
          <label>Punkty za skalę przy braku danych (0–1)<input type="number" step={0.1} min={0} max={1} value={w.unknown_scale_factor} onChange={(e) => setW({ ...w, unknown_scale_factor: Number(e.target.value) })} /></label>
        </div>
        <p>Suma: <b className={sum === 100 ? "" : "error"}>{sum}</b></p>
        <button disabled={!validateWeights(w)} onClick={async () => { await api.saveWeights(w); setMsg("Zapisano. Nowe wagi działają dla kolejnych wyszukiwań."); }}>Zapisz wagi</button>
        {msg && <p className="info">{msg}</p>}
      </section>

      <section className="card">
        <h2>RODO — usunięcie danych na żądanie</h2>
        <p className="muted">Usuwa leady z danym NIP lub domeną w Twojej organizacji i blokuje ich ponowne zbieranie.</p>
        <div className="row">
          <input placeholder="NIP" value={nip} onChange={(e) => setNip(e.target.value)} />
          <input placeholder="lub domena, np. firma.pl" value={domain} onChange={(e) => setDomain(e.target.value)} />
          <button className="danger" onClick={async () => {
            const n = await api.eraseSubject(nip || null, domain || null);
            setMsg(`Usunięto ${n} rekord(ów) i dodano do listy blokad.`);
          }}>Usuń i zablokuj</button>
        </div>
      </section>
    </div>
  );
}
