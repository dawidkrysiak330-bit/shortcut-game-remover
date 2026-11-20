// =============================================================
// generate-icp — fraza produktu → propozycja ICP (do edycji przez użytkownika).
// ICP to HIPOTEZA handlowa, nie fakt o konkretnej firmie — użytkownik ją poprawia
// przed wyszukiwaniem. Kody PKD/NACE trzeba zweryfikować (patrz README).
// =============================================================
import { getClients, handler, HttpError, json } from "../_shared/http.ts";
import { callJson } from "../_shared/llm.ts";
import { costMeter } from "../_shared/costs.ts";
import { IcpSchema } from "../_shared/core/schemas.ts";

const SYSTEM = `Jesteś analitykiem sprzedaży B2B w Polsce. Na podstawie produktu, który sprzedaje firma użytkownika,
przygotuj profil kupca (ICP): jakie branże KUPUJĄ lub WYKORZYSTUJĄ ten produkt (nie te, które go produkują).
Zwróć JSON o polach:
{"product": string, "buyer_industries": string[], "pkd_codes": string[] (format "NN.NN.X", PKD 2007),
 "nace_codes": string[] (format "NN.NN", NACE Rev.2), "keywords": string[] (3–8 krótkich fraz do wyszukiwarki Google Maps po polsku, opisujących KUPUJĄCE firmy),
 "buying_signals": string[] (frazy, które mogą pojawić się na stronie www kupującej firmy, świadczące o potrzebie),
 "exclusion_signals": string[] (frazy świadczące, że firma to konkurent/producent tego samego produktu),
 "target_scale": ("micro"|"small"|"medium"|"large")[]}
Nie wymyślaj kodów, których nie jesteś pewien — lepiej mniej kodów. Pola tekstowe po polsku.`;

Deno.serve(handler(async (req) => {
  const { phrase, org_id } = await req.json();
  if (typeof phrase !== "string" || phrase.trim().length < 2 || phrase.length > 200) throw new HttpError(400, "Podaj frazę produktu (2–200 znaków)");
  const { userClient, admin } = await getClients(req);
  const { data: org } = await userClient.from("organizations").select("id").eq("id", org_id).maybeSingle();
  if (!org) throw new HttpError(403, "Brak dostępu do organizacji");

  const meter = costMeter(admin, org_id, null);
  const res = await callJson({ system: SYSTEM, user: `Produkt: ${phrase.trim()}`, schema: IcpSchema, meter, effort: "medium" });
  if (!res.ok) {
    await admin.from("llm_rejections").insert({ org_id, kind: "icp", raw_output: res.raw.slice(0, 20000), errors: res.errors });
    throw new HttpError(422, "Model zwrócił niepoprawny ICP — spróbuj ponownie lub uzupełnij ręcznie. Szczegóły: " + res.errors.slice(0, 3).join("; "));
  }
  const { data: saved } = await userClient.from("icps").insert({ org_id, product_phrase: phrase.trim(), icp: res.data }).select("id").single();
  return json({ icp: res.data, icp_id: saved?.id, cost_usd: meter.total() });
}));
