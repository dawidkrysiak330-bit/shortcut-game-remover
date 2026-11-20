// =============================================================
// Eksport CSV / XLSX. PDF karty = drukowanie strony karty (Ctrl+P → "Zapisz jako PDF").
// ZGODNOŚĆ: do eksportu NIE trafiają treści z Google Places (nazwy, adresy, telefony
// pobrane z Google) — tylko place_id i link do Map. Dane z rejestrów i www — tak, ze źródłem.
// =============================================================
import type { FieldKey, FieldValue } from "../../supabase/functions/_shared/core/types.ts";
import type { LeadRow } from "./api";

const COLUMNS: { key: FieldKey; label: string }[] = [
  { key: "name", label: "Nazwa" }, { key: "nip", label: "NIP" }, { key: "regon", label: "REGON" }, { key: "krs", label: "KRS" },
  { key: "legal_form", label: "Forma prawna" }, { key: "status", label: "Status" }, { key: "vat_status", label: "Status VAT" },
  { key: "address", label: "Adres" }, { key: "postal_code", label: "Kod" }, { key: "city", label: "Miejscowość" },
  { key: "region", label: "Region" }, { key: "website", label: "WWW" }, { key: "phone", label: "Telefon firmowy" },
  { key: "email", label: "E-mail firmowy" }, { key: "pkd", label: "PKD" },
];

/** Pierwsza wartość pola z pominięciem źródła Google Places. */
function exportable(list: FieldValue[] | undefined): FieldValue | undefined {
  return list?.find((fv) => fv.source !== "google_places");
}

export function leadsToRows(leads: LeadRow[]): string[][] {
  const header = [...COLUMNS.map((c) => c.label), "Score %", "Pewność danych", "Wykluczony", "Uzasadnienie", "Google place_id", "Źródła pól"];
  const rows = leads.map((l) => {
    const f = l.company.fields;
    const vals = COLUMNS.map(({ key }) => {
      const fv = exportable(f[key]);
      if (!fv) return "[BRAK DANYCH]";
      return Array.isArray(fv.value) ? fv.value.join(", ") : fv.value;
    });
    const sources = COLUMNS.flatMap(({ key }) => {
      const fv = exportable(f[key]);
      return fv ? [`${key}: ${fv.source} ${fv.fetched_at.slice(0, 10)}${fv.source_url ? " " + fv.source_url : ""}`] : [];
    }).join(" | ");
    return [
      ...vals, String(l.score.total), l.score.confidence, l.score.excluded ? "tak" : "nie",
      l.score.excluded ? l.score.exclusion_reason ?? "" : l.score.justification,
      l.place_id ?? "", sources,
    ];
  });
  return [header, ...rows];
}

function download(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function exportCsv(leads: LeadRow[], filename = "leady.csv") {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  // BOM + średnik — polski Excel otwiera poprawnie
  const csv = "﻿" + leadsToRows(leads).map((r) => r.map(esc).join(";")).join("\r\n");
  download(new Blob([csv], { type: "text/csv;charset=utf-8" }), filename);
}

export async function exportXlsx(leads: LeadRow[], filename = "leady.xlsx") {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Leady");
  leadsToRows(leads).forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  ws.columns.forEach((c) => (c.width = 22));
  const info = wb.addWorksheet("Informacje");
  info.addRow(["Eksport nie zawiera treści z Google Places (tylko place_id) — zgodnie z warunkami Google."]);
  info.addRow(["Pierwszy kontakt marketingowy e-mail/telefon wymaga uprzedniej zgody (art. 398 Prawa komunikacji elektronicznej) — także w B2B."]);
  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
}
