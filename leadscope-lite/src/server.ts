// =============================================================
// LeadScope Lite — lokalny serwer (Node.js, bez dodatkowych bibliotek).
// Uruchom:  npm start   → http://localhost:8787
// Klucz Google trzymany jest TYLKO tutaj (plik .env), nigdy w przeglądarce.
// =============================================================
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { REGIONS } from "../../leadscope/supabase/functions/_shared/core/regions.ts";
import { mockProviders, realProviders, type Providers } from "./providers.ts";
import { runJob, toCsv, type Job } from "./job.ts";
import { fileQuota, memoryQuota } from "./quota.ts";

const envFile = new URL("../.env", import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile.pathname);

const PORT = Number(process.env.PORT ?? 8787);
const MOCK = process.env.LITE_MOCK === "1" || process.argv.includes("--demo");
const PRICE = Number(process.env.PLACES_PRICE_PER_REQUEST_USD ?? "0"); // ZWERYFIKUJ w cenniku Google
const JOB_TTL_MS = 60 * 60 * 1000; // wyniki (w tym treści Google) żyją max 1 h, tylko w pamięci
const MAX_RESULTS = Number(process.env.MAX_RESULTS ?? 100);

if (!MOCK && !process.env.GOOGLE_PLACES_API_KEY) {
  console.error("Brak GOOGLE_PLACES_API_KEY w pliku .env (albo uruchom tryb demo: npm run demo)");
  process.exit(1);
}
const providers: Providers = MOCK ? mockProviders() : realProviders(process.env.GOOGLE_PLACES_API_KEY!);
// Miesięczny limit zapytań do Google = gwarancja, że zostajemy w darmowej puli (patrz README).
const FREE_LIMIT = Number(process.env.GOOGLE_MONTHLY_REQUEST_LIMIT ?? 900);
const quota = MOCK ? memoryQuota(FREE_LIMIT) : fileQuota(new URL("../.usage.json", import.meta.url).pathname, FREE_LIMIT);
const jobs = new Map<string, Job>();

// sprzątanie starych zadań
setInterval(() => { for (const [id, j] of jobs) if (Date.now() - j.created_at > JOB_TTL_MS) jobs.delete(id); }, 60_000).unref();

function send(res: ServerResponse, status: number, body: unknown, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = "";
  for await (const chunk of req) { data += chunk; if (data.length > 100_000) throw new Error("Za duże zapytanie"); }
  return JSON.parse(data || "{}");
}

function publicJob(j: Job) {
  return {
    id: j.id, status: j.status, stage: j.stage, progress: j.progress, error: j.error,
    places_requests: j.places_requests, biala_lista_requests: j.biala_lista_requests,
    cost_usd: j.places_requests * PRICE, price_verified: PRICE > 0, quota: quota.status(), quota_note: j.quota_note,
    leads: j.leads,
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    // Serwer słucha tylko na localhost; dodatkowo odrzucamy zapytania z obcych stron (CSRF).
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return send(res, 403, { error: "Niedozwolone źródło zapytania" });

    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, await readFile(new URL("../public/index.html", import.meta.url), "utf-8"), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      return send(res, 200, { mock: MOCK, price_per_request: PRICE, quota: quota.status(), regions: REGIONS.map((r) => ({ code: r.code, name: r.name })) });
    }
    if (req.method === "POST" && url.pathname === "/api/search") {
      const b = await readJson(req);
      const phrases = String(b.phrases ?? "").split("\n").map((s) => s.trim()).filter((s) => s.length >= 2).slice(0, 10);
      const region = REGIONS.find((r) => r.code === b.region_code);
      if (!phrases.length) return send(res, 400, { error: "Podaj co najmniej jedną frazę" });
      if (!region) return send(res, 400, { error: "Wybierz województwo (filtr obowiązkowy)" });
      const radius = b.radius_km ? Number(b.radius_km) : undefined;
      if (radius && !b.city) return send(res, 400, { error: "Promień wymaga podania miasta" });
      const job: Job = {
        id: randomUUID(), status: "running", stage: "Start", progress: 0, places_requests: 0, biala_lista_requests: 0, leads: [], created_at: Date.now(), cancel: false,
        params: {
          phrases, region, city: b.city ? String(b.city).slice(0, 80) : undefined, radius_km: radius && radius > 0 && radius <= 300 ? radius : undefined,
          crawl_websites: b.crawl_websites !== false, use_biala_lista: !!b.use_biala_lista, max_results: Math.min(Number(b.max_results ?? MAX_RESULTS), 200),
        },
      };
      jobs.set(job.id, job);
      if (quota.status().remaining === 0) return send(res, 429, { error: `Wyczerpano miesięczny limit darmowych zapytań Google (${FREE_LIMIT}). Odnowi się w nowym miesiącu.` });
      void runJob(job, providers, quota);
      return send(res, 200, { id: job.id });
    }
    const m = url.pathname.match(/^\/api\/jobs\/([\w-]+)(\/cancel|\/export\.csv)?$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: "Nie ma takiego wyszukiwania (wyniki trzymamy max 1 h)" });
      if (req.method === "GET" && !m[2]) return send(res, 200, publicJob(job));
      if (req.method === "POST" && m[2] === "/cancel") { job.cancel = true; return send(res, 200, { ok: true }); }
      if (req.method === "GET" && m[2] === "/export.csv") {
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="leady-${new Date().toISOString().slice(0, 10)}.csv"` });
        return res.end(toCsv(job.leads));
      }
    }
    send(res, 404, { error: "Nie znaleziono" });
  } catch (e) {
    send(res, 500, { error: String(e instanceof Error ? e.message : e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`LeadScope Lite: http://localhost:${PORT}${MOCK ? "  (TRYB DEMO — dane fikcyjne)" : ""}`);
});
