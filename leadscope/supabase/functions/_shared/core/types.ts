// =============================================================
// Wspólne typy danych. Ten plik NIE ma zależności — używa go
// zarówno backend (Deno / Edge Functions), jak i frontend + testy.
// =============================================================

/** Identyfikator źródła danych. Każda wartość pola ma przypisane źródło. */
export type SourceId =
  | "google_places"
  | "gus_bir"
  | "krs"
  | "ceidg"
  | "biala_lista"
  | "vies"
  | "website"
  | "user";

/** Klucze pól firmy, które zbieramy. */
export type FieldKey =
  | "name"
  | "nip"
  | "regon"
  | "krs"
  | "legal_form"
  | "status" // status w rejestrze, np. "aktywny", "wykreślony"
  | "vat_status" // Biała lista: "Czynny" / "Zwolniony" / "Niezarejestrowany"
  | "registration_date"
  | "address"
  | "postal_code"
  | "city"
  | "region" // nazwa województwa
  | "website"
  | "phone" // tylko firmowy, publicznie podany
  | "email" // tylko firmowy, rolowy (biuro@, info@ …)
  | "pkd" // lista kodów PKD (np. "25.62.Z")
  | "description_text" // opis działalności z rejestru (np. przedmiot działalności KRS)
  | "lat"
  | "lng"
  | "place_id"
  | "business_status" // Google Places: OPERATIONAL / CLOSED_PERMANENTLY …
  | "types"; // Google Places: typy miejsca

/** Pojedyncza wartość pola + skąd i kiedy ją pobrano (wymóg: 0 pól bez źródła). */
export interface FieldValue {
  value: string | string[];
  source: SourceId;
  source_url?: string;
  fetched_at: string; // ISO 8601
}

/** Surowy rekord zwrócony przez adapter źródła — jeden rekord = jedno źródło. */
export interface RawCompany {
  source: SourceId;
  source_url?: string;
  fetched_at: string;
  fields: Partial<Record<FieldKey, string | string[]>>;
  /** true, jeśli rekord dotyczy osoby fizycznej prowadzącej JDG (RODO!). */
  is_natural_person?: boolean;
}

/** Fragment tekstu ze strony www firmy. */
export interface WebsitePage {
  url: string;
  text: string;
  fetched_at: string;
}

/** Firma po deduplikacji: każde pole może mieć kilka wartości z różnych źródeł. */
export interface MergedCompany {
  key: string; // stabilny klucz deduplikacji (np. "nip:1234567890")
  fields: Partial<Record<FieldKey, FieldValue[]>>;
  sources: SourceId[];
  website_pages: WebsitePage[];
  is_natural_person: boolean;
}

export type Scale = "micro" | "small" | "medium" | "large";

/** Profil kupca (ICP) — edytowany przez użytkownika przed wyszukiwaniem. */
export interface Icp {
  product: string;
  buyer_industries: string[];
  pkd_codes: string[]; // format "NN.NN.X"
  nace_codes: string[]; // format "NN.NN"
  keywords: string[]; // frazy do wyszukiwania w Google Places
  buying_signals: string[]; // frazy na www świadczące o potrzebie
  exclusion_signals: string[]; // np. frazy świadczące, że to konkurent
  target_scale: Scale[];
}

export interface Weights {
  industry: number;
  buying_signals: number;
  scale: number;
  location: number;
  activity: number;
  contact: number;
  /** ułamek punktów za skalę, gdy brak danych o skali (oznaczane [NIEPEWNE]) */
  unknown_scale_factor: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  industry: 30,
  buying_signals: 25,
  scale: 15,
  location: 10,
  activity: 10,
  contact: 10,
  unknown_scale_factor: 0.5,
};

export type ComponentKey = "industry" | "buying_signals" | "scale" | "location" | "activity" | "contact";

export interface Evidence {
  field: FieldKey | "website_text";
  source: SourceId;
  source_url?: string;
  fetched_at: string;
  snippet: string;
}

export interface ComponentScore {
  points: number;
  max: number;
  reason: string;
  flags: ("NIEPEWNE" | "BRAK DANYCH")[];
  evidence: Evidence[];
}

export type Confidence = "Wysoka" | "Średnia" | "Niska";

export interface ScoreResult {
  total: number; // 0–100
  components: Record<ComponentKey, ComponentScore>;
  excluded: boolean;
  exclusion_reason?: string;
  confidence: Confidence;
  confirmed_fields: FieldKey[];
  justification: string; // 1–2 zdania, budowane wyłącznie z zebranych danych
}

export interface SearchContext {
  country: string; // "PL"
  region_name: string; // np. "małopolskie"
  center?: { lat: number; lng: number };
  radius_km?: number;
}
