// =============================================================
// Deduplikacja rekordów z wielu źródeł.
// Kolejność kluczy: NIP → domena → telefon → nazwa+adres (fuzzy).
// Zasada bezpieczeństwa: dwa rekordy z RÓŻNYMI poprawnymi NIP-ami
// nigdy nie są łączone (np. spółki z grupy na wspólnej domenie).
// =============================================================
import type { FieldKey, FieldValue, MergedCompany, RawCompany, SourceId, WebsitePage } from "./types.ts";
import { normalizeDomain, normalizeName, normalizeNip, normalizePhone, normText, similarity } from "./normalize.ts";

/** Próg podobieństwa nazw (po usunięciu formy prawnej). */
export const NAME_SIMILARITY_THRESHOLD = 0.85;

/** Fuzzy porównanie nazw; różne liczby w nazwie ("Serwis 1" vs "Serwis 2") = różne firmy. */
export function namesMatch(a: string, b: string): boolean {
  const digits = (s: string) => (s.match(/\d+/g) ?? []).join(",");
  if (digits(a) !== digits(b)) return false;
  return similarity(a, b) >= NAME_SIMILARITY_THRESHOLD;
}

interface Cluster {
  records: RawCompany[];
  nips: Set<string>;
  domains: Set<string>;
  phones: Set<string>;
  names: string[];
  postal: Set<string>;
  cities: Set<string>;
}

function asList(v: string | string[] | undefined): string[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function keysOf(r: RawCompany) {
  const f = r.fields;
  return {
    nip: normalizeNip(asList(f.nip)[0]),
    domain: normalizeDomain(asList(f.website)[0]),
    phones: asList(f.phone).map(normalizePhone).filter((p): p is string => !!p),
    name: f.name ? normalizeName(asList(f.name)[0]) : null,
    postal: asList(f.postal_code)[0]?.replace(/\s/g, "") ?? null,
    city: f.city ? normText(asList(f.city)[0]) : null,
  };
}

/** Jak (i czy) rekord pasuje do klastra. Zwraca nazwę klucza dopasowania lub null. */
export function matchReason(c: Cluster, r: RawCompany): "nip" | "domain" | "phone" | "name_address" | null {
  const k = keysOf(r);
  // Twarda reguła: różne NIP-y = różne firmy
  if (k.nip && c.nips.size > 0 && !c.nips.has(k.nip)) return null;
  if (k.nip && c.nips.has(k.nip)) return "nip";
  if (k.domain && c.domains.has(k.domain)) return "domain";
  if (k.phones.some((p) => c.phones.has(p))) return "phone";
  if (k.name) {
    const sameLocation = (k.postal && c.postal.has(k.postal)) || (k.city && c.cities.has(k.city));
    if (sameLocation && c.names.some((n) => namesMatch(n, k.name!))) {
      return "name_address";
    }
  }
  return null;
}

function addToCluster(c: Cluster, r: RawCompany) {
  const k = keysOf(r);
  c.records.push(r);
  if (k.nip) c.nips.add(k.nip);
  if (k.domain) c.domains.add(k.domain);
  k.phones.forEach((p) => c.phones.add(p));
  if (k.name) c.names.push(k.name);
  if (k.postal) c.postal.add(k.postal);
  if (k.city) c.cities.add(k.city);
}

/** Grupuje surowe rekordy w klastry (= unikalne firmy). */
export function clusterRecords(records: RawCompany[]): RawCompany[][] {
  const clusters: Cluster[] = [];
  for (const r of records) {
    const target = clusters.find((c) => matchReason(c, r) !== null);
    if (target) addToCluster(target, r);
    else {
      const c: Cluster = { records: [], nips: new Set(), domains: new Set(), phones: new Set(), names: [], postal: new Set(), cities: new Set() };
      addToCluster(c, r);
      clusters.push(c);
    }
  }
  // Drugi przebieg: klastry mogły się "zbliżyć" (np. NIP dotarł później) — scalamy je.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (clusters[j].records.some((r) => matchReason(clusters[i], r) !== null)) {
          // nie scalaj, jeśli NIP-y kolidują
          const conflict = [...clusters[j].nips].some((n) => clusters[i].nips.size > 0 && !clusters[i].nips.has(n));
          if (conflict) continue;
          clusters[j].records.forEach((r) => addToCluster(clusters[i], r));
          clusters.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return clusters.map((c) => c.records);
}

/** Klucz stabilny dla klastra (NIP > domena > telefon > nazwa). */
export function clusterKey(records: RawCompany[]): string {
  for (const r of records) { const n = normalizeNip(asList(r.fields.nip)[0]); if (n) return `nip:${n}`; }
  for (const r of records) { const d = normalizeDomain(asList(r.fields.website)[0]); if (d) return `domain:${d}`; }
  for (const r of records) { const p = asList(r.fields.phone).map(normalizePhone).find(Boolean); if (p) return `phone:${p}`; }
  const first = records[0];
  return `name:${normalizeName(asList(first.fields.name)[0] ?? "?")}|${asList(first.fields.postal_code)[0] ?? ""}`;
}

/** Normalizacja wartości do porównań (czy dwa źródła "potwierdzają" to samo). */
export function comparable(key: FieldKey, v: string): string {
  switch (key) {
    case "nip": return normalizeNip(v) ?? normText(v);
    case "phone": return normalizePhone(v) ?? normText(v);
    case "website": return normalizeDomain(v) ?? normText(v);
    case "name": return normalizeName(v);
    case "postal_code": return v.replace(/\s/g, "");
    default: return normText(v);
  }
}

/** Scala rekordy klastra w jedną firmę; każda wartość zachowuje źródło i datę. */
export function mergeCluster(records: RawCompany[], pages: WebsitePage[] = []): MergedCompany {
  const fields: Partial<Record<FieldKey, FieldValue[]>> = {};
  const sources = new Set<SourceId>();
  for (const r of records) {
    sources.add(r.source);
    for (const [k, v] of Object.entries(r.fields) as [FieldKey, string | string[]][]) {
      if (v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === "") continue;
      const list = (fields[k] ??= []);
      const sig = Array.isArray(v) ? v.map((x) => comparable(k, x)).sort().join("|") : comparable(k, v);
      const dup = list.some((fv) => fv.source === r.source &&
        (Array.isArray(fv.value) ? fv.value.map((x) => comparable(k, x)).sort().join("|") : comparable(k, fv.value)) === sig);
      if (!dup) list.push({ value: v, source: r.source, source_url: r.source_url, fetched_at: r.fetched_at });
    }
  }
  return {
    key: clusterKey(records),
    fields,
    sources: [...sources],
    website_pages: pages,
    is_natural_person: records.some((r) => r.is_natural_person),
  };
}

/** Pełna deduplikacja: rekordy → unikalne firmy. */
export function dedupe(records: RawCompany[], pagesByDomain: Record<string, WebsitePage[]> = {}): MergedCompany[] {
  return clusterRecords(records).map((cl) => {
    const domain = cl.map((r) => normalizeDomain(asList(r.fields.website)[0])).find(Boolean);
    return mergeCluster(cl, domain ? pagesByDomain[domain] ?? [] : []);
  });
}

/** Pierwsza wartość pola (tekstowo) — pomocnicze. */
export function firstValue(c: MergedCompany, key: FieldKey): FieldValue | undefined {
  return c.fields[key]?.[0];
}
export function firstString(c: MergedCompany, key: FieldKey): string | undefined {
  const v = firstValue(c, key)?.value;
  return Array.isArray(v) ? v[0] : v;
}
