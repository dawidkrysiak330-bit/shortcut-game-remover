// Wspólne helpery HTTP + klienci Supabase dla Edge Functions.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/**
 * userClient — działa z uprawnieniami zalogowanego użytkownika (RLS!) → do sprawdzania dostępu.
 * admin — service role (omija RLS) → TYLKO do zapisu wyników po sprawdzeniu dostępu.
 */
export async function getClients(req: Request): Promise<{ userClient: SupabaseClient; admin: SupabaseClient; userId: string }> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "Niezalogowany");
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  return { userClient, admin, userId: data.user.id };
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Opakowanie handlera: CORS + obsługa błędów. */
export function handler(fn: (req: Request) => Promise<Response>) {
  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    try {
      return await fn(req);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      console.error(e);
      return json({ error: e instanceof Error ? e.message : String(e) }, status);
    }
  };
}
