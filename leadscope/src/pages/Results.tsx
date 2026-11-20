// Lista leadów: filtry dodatkowe + eksport CSV/XLSX.
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type LeadRow } from "../lib/api";
import { exportCsv, exportXlsx } from "../lib/export";
import { applyFilters, type LeadFilters } from "../../supabase/functions/_shared/core/pipeline.ts";
import { firstString } from "../../supabase/functions/_shared/core/dedup.ts";

export default function Results() {
  const { searchId } = useParams();
  const [leads, setLeads] = useState<LeadRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState<LeadFilters>({ hide_excluded: true });

  useEffect(() => { api.listLeads(searchId!).then(setLeads).catch((e) => setError(String(e.message ?? e))); }, [searchId]);

  const filtered = useMemo(() => {
    if (!leads) return [];
    const asLead = leads.map((l) => ({ company: l.company, score: l.score, row: l }));
    return applyFilters(asLead, f).map((x) => (x as typeof asLead[number]).row);
  }, [leads, f]);

  if (error) return <p className="error">{error}</p>;
  if (!leads) return <p>Ładowanie…</p>;

  return (
    <div>
      <h1>Wyniki: {leads.length} firm</h1>
      <section className="card filters">
        <label>Min. score %<input data-testid="min-score" type="number" min={0} max={100} value={f.min_score ?? ""} onChange={(e) => setF({ ...f, min_score: e.target.value ? Number(e.target.value) : undefined })} /></label>
        <label>PKD (prefiks)<input value={f.pkd ?? ""} onChange={(e) => setF({ ...f, pkd: e.target.value || undefined })} placeholder="np. 31 lub 25.62" /></label>
        <label>Forma prawna<input value={f.legal_form ?? ""} onChange={(e) => setF({ ...f, legal_form: e.target.value || undefined })} placeholder="np. akcyjna" /></label>
        <label>Status<input value={f.status ?? ""} onChange={(e) => setF({ ...f, status: e.target.value || undefined })} placeholder="np. aktywny" /></label>
        <label className="inline"><input type="checkbox" checked={!!f.only_with_website} onChange={(e) => setF({ ...f, only_with_website: e.target.checked })} /> tylko z www</label>
        <label className="inline"><input type="checkbox" checked={!!f.only_with_phone} onChange={(e) => setF({ ...f, only_with_phone: e.target.checked })} /> tylko z telefonem</label>
        <label className="inline"><input type="checkbox" checked={!!f.hide_excluded} onChange={(e) => setF({ ...f, hide_excluded: e.target.checked })} /> ukryj wykluczone (0%)</label>
      </section>
      <div className="row no-print">
        <span data-testid="count">Pokazano: {filtered.length}</span>
        <button data-testid="export-csv" onClick={() => exportCsv(filtered)}>Eksport CSV</button>
        <button onClick={() => exportXlsx(filtered)}>Eksport XLSX</button>
      </div>
      <p className="muted">Eksport nie zawiera treści pobranych z Google (tylko place_id). Kolumna „Źródła pól” podaje źródło i datę każdej wartości.</p>
      <table data-testid="results">
        <thead><tr><th>Score</th><th>Firma</th><th>Miejscowość</th><th>Pewność</th><th>Uzasadnienie</th></tr></thead>
        <tbody>
          {filtered.map((l) => (
            <tr key={l.id} className={l.score.excluded ? "excluded" : ""}>
              <td><b>{l.score.total}%</b></td>
              <td><Link to={`/lead/${l.id}`}>{firstString(l.company, "name") ?? "[BRAK DANYCH]"}</Link>{l.is_natural_person && <span className="tag">JDG</span>}</td>
              <td>{firstString(l.company, "city") ?? "[BRAK DANYCH]"}</td>
              <td>{l.score.confidence}</td>
              <td className="small">{l.score.excluded ? l.score.exclusion_reason : l.score.justification}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {leads.some((l) => l.place_id) && <p className="attribution">Część danych: Google Maps</p>}
    </div>
  );
}
