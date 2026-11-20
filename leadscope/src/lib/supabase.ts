import { createClient } from "@supabase/supabase-js";

// Klucz "anon" jest publiczny z założenia — bezpieczeństwo zapewnia RLS w bazie.
// Klucze API zewnętrznych usług (Google, GUS, Anthropic) są TYLKO w sekretach Edge Functions.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase = url && anon ? createClient(url, anon) : null;
