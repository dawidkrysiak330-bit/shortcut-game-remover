# LeadScope — MVP wyszukiwarki leadów B2B

Handlowiec wpisuje produkt, który sprzedaje jego firma, wybiera kraj i województwo. Aplikacja:

1. proponuje profil kupca (ICP), który handlowiec poprawia,
2. szuka firm w Google Places i wzbogaca je danymi ze strony www i z rejestrów,
3. usuwa duplikaty, liczy score 0–100% z rozbiciem na składowe,
4. pokazuje kartę leada i pozwala wyeksportować CSV/XLSX oraz zapisać kartę jako PDF.

Stack: React + Vite, Supabase (Postgres + Auth + Edge Functions + RLS), Claude API.

> **Ważne — co jest zweryfikowane, a co nie.** Środowisko, w którym powstał kod, nie miało dostępu do dokumentacji
> Google ani do API rejestrów. Endpointy, limity, ceny i regulaminy są opisane z wiedzy ogólnej i **oznaczone
> „ZWERYFIKUJ”** w kodzie i w [SOURCES.md](SOURCES.md). Zanim zaczniesz sprzedawać, sprawdź je w oficjalnej
> dokumentacji (linki w SOURCES.md).
> **Zweryfikowane uruchomieniem:** testy jednostkowe (29), test E2E na mockach (2 scenariusze), typy Edge Functions
> (`deno check`), migracja SQL i polityki RLS na PostgreSQL 16.

---

## 1. Plan

### Moduły

| Moduł | Gdzie | Co robi |
|---|---|---|
| Rdzeń (bez I/O) | `supabase/functions/_shared/core/` | typy, normalizacja (NIP, telefon, domena, e-mail rolowy), **deduplikacja**, **scoring**, robots.txt, schematy zod, kontrola „ugruntowania” odpowiedzi LLM, regiony. Używany przez backend, frontend i testy. |
| Adaptery źródeł | `supabase/functions/_shared/adapters/` | `googlePlaces`, `bialaLista`, `gusBir`, `krs`, `ceidg`, `vies`, `website`. Wspólny interfejs w `types.ts`. |
| Edge Function `generate-icp` | `supabase/functions/generate-icp/` | fraza → ICP (Claude, JSON walidowany zod; złe odpowiedzi odrzucane i logowane). |
| Edge Function `run-search` | `supabase/functions/run-search/` | kolejka zadań: każde wywołanie („tick”) wykonuje ~40 s pracy, zapisuje postęp, sprawdza przerwanie i limity kosztów. |
| Edge Function `lead-card` | `supabase/functions/lead-card/` | karta leada z LLM (tylko z zebranych danych) + odświeżanie danych Google po `place_id`. |
| Baza | `supabase/migrations/` | multi-tenant, RLS, koszty, retencja, RODO (usuwanie + lista blokad). |
| Frontend | `src/` | logowanie, wyszukiwanie + edycja ICP, pasek postępu i przerwanie, wyniki z filtrami, karta, eksport, ustawienia wag, koszty, RODO. |
| Testy | `tests/unit`, `tests/e2e` | scoring, deduplikacja, normalizacja, robots.txt, walidacja LLM; E2E Playwright na danych fikcyjnych. |

### Przepływ wyszukiwania

```
fraza ──generate-icp──▶ ICP (edycja przez użytkownika)
  │
  ▼  insert do `searches` (status queued) — frontend co 1,5 s woła run-search
queued ─▶ discovering: Google Places Text Search (słowa kluczowe × do 3 stron po 20)
       ─▶ enriching:   www (robots.txt, ≤4 strony, NIP + e-mail rolowy) → NIP → Biała lista + GUS BIR
                       → KRS (gdy jest nr KRS) → CEIDG (gdy JDG)
       ─▶ scoring:     deduplikacja → scoring → zapis `leads` → usunięcie danych roboczych
       ─▶ done         (w każdej chwili: cancel_requested → cancelled; limit kosztu → przejście do scoringu)
```

### Schemat bazy (najważniejsze tabele)

| Tabela | Opis | RLS |
|---|---|---|
| `plans` | limity planów (wyszukiwania/mies., max koszt wyszukiwania, max wyników) | odczyt: zalogowani |
| `organizations`, `memberships` | tenant + role (`owner`/`member`); nowy użytkownik dostaje własną organizację | członkowie |
| `scoring_weights` | **tabela konfiguracyjna wag** (CHECK: suma = 100); wiersz `org_id = NULL` = domyślne | odczyt: członkowie, zapis: owner |
| `source_pricing` | ceny jednostkowe źródeł (`verified=false` = do uzupełnienia) | odczyt: zalogowani |
| `icps` | zapisane profile kupca | członkowie |
| `searches` | parametry, status, postęp, stan kolejki, koszt, przerwanie | odczyt członkowie; użytkownik może zmienić tylko `cancel_requested` |
| `raw_records` | surowe rekordy ze źródeł (dane robocze, kasowane po zakończeniu) | tylko backend |
| `leads` | wynik: `data` (rejestry/www), `places_data` + `places_expires_at` (Google, wygasa), `place_id`, `score`, `card`, `expires_at` (retencja) | odczyt/usuwanie: członkowie |
| `api_usage` | licznik kosztów per wyszukiwanie/źródło | odczyt: członkowie |
| `llm_rejections` | odrzucone odpowiedzi LLM + powody | tylko backend |
| `suppression_list`, `erasure_requests` | RODO: lista „nie zbieraj” i rejestr żądań | backend / odczyt członkowie |

Każda wartość w `leads.data` ma postać `{ value, source, source_url, fetched_at }` — nie ma pól bez źródła.

### Klucze API (sekrety Edge Functions — nigdy we frontendzie)

| Sekret | Do czego | Gdzie zdobyć |
|---|---|---|
| `ANTHROPIC_API_KEY` | ICP + karta leada | https://platform.claude.com/ → API Keys |
| `GOOGLE_PLACES_API_KEY` | wyszukiwanie firm | https://console.cloud.google.com/ → włącz „Places API (New)” → Credentials → API key (ogranicz klucz do Places API; wymagane konto rozliczeniowe) |
| `GUS_BIR_KEY` | REGON, PKD, forma prawna | https://api.stat.gov.pl/Home/RegonApi — wniosek o klucz (do testów: środowisko testowe + `GUS_BIR_ENV=test`) |
| `CEIDG_API_TOKEN` (opcjonalny) | weryfikacja JDG | https://dane.biznes.gov.pl/ — wniosek o token |
| — | Biała lista VAT, KRS, VIES | bez klucza (limity — patrz SOURCES.md) |
| `BOT_INFO_URL` | adres strony z opisem bota w User-Agent | Twoja strona, np. `https://twojadomena.pl/bot` |
| `ALLOWED_ORIGIN` | CORS — adres Twojego frontendu | np. `https://app.twojadomena.pl` |
| `PLACES_CONTENT_TTL_HOURS` | ile godzin trzymać treści Google przy leadzie (domyślnie 24) | ustaw wg warunków Google (COMPLIANCE.md) |
| `ANTHROPIC_MODEL` (opcjonalny) | model LLM (domyślnie `claude-opus-5-5`) | — |

---

## 2. Pytania (i założenia, jeśli nie odpowiesz)

1. **Gdzie macie siedzibę i adres rozliczeniowy Ty i Twoi klienci?** Od tego zależą warunki Google Maps Platform (dla EOG są osobne warunki).
   *Założenie:* wszyscy w Polsce/EOG → obowiązują warunki EOG; trzymamy się wariantu najostrożniejszego (trwale tylko `place_id`).
2. **Kto jest administratorem danych leadów — Ty (operator SaaS) czy klient?**
   *Założenie:* klient jest administratorem, Ty podmiotem przetwarzającym (umowa powierzenia, art. 28 RODO). Szablon art. 14 dostaje klient. **Skonsultuj z prawnikiem.**
3. **Jakie limity i ceny planów?**
   *Założenie:* plany `trial` / `starter` / `pro` w tabeli `plans` (wartości przykładowe — zmień je).
4. **Czy MVP obejmuje tylko Polskę?**
   *Założenie:* tak — 16 województw (TERYT + NUTS 2). Inne kraje UE: Places + VIES, bez rejestrów krajowych (do dodania w `regions.ts`).
5. **Jaki budżet na LLM na jedno wyszukiwanie?**
   *Założenie:* scoring jest deterministyczny (bez LLM). LLM generuje tylko ICP (1 wywołanie) i kartę **na żądanie** (przycisk na karcie) — dzięki temu koszt rośnie tylko z liczbą otwartych kart.

---

## 3. Uruchomienie krok po kroku

### Wymagania
- Node.js 22+ (https://nodejs.org), Docker Desktop (do lokalnego Supabase), Git.

### Krok 0 — tryb demo (bez kont i kluczy, 2 minuty)
```bash
cd leadscope
npm install
npm run dev:mock        # otwórz http://localhost:5173
```
Wpisz dowolną frazę → „Zaproponuj profil kupca” → wybierz „małopolskie” → „Szukaj firm”. Dane są fikcyjne, ale deduplikacja i scoring to prawdziwy kod.

### Testy
```bash
npm test                                  # testy jednostkowe (scoring, dedup, normalizacja, robots.txt, walidacja LLM)
npx playwright install chromium           # jednorazowo
npm run test:e2e                          # E2E na mockach
```

### Etap E1 — baza + auth
```bash
npx supabase@2.122.1 init                 # tworzy supabase/config.toml (na pytania odpowiedz "N")
npx supabase@2.122.1 start                # lokalny Supabase w Dockerze (pierwszy raz kilka minut)
npx supabase@2.122.1 db reset             # wgrywa migracje z supabase/migrations
npx supabase@2.122.1 status               # skopiuj "API URL" i "anon key"
cp .env.example .env.local                # wklej API URL i anon key
npm run dev                               # http://localhost:5173 → "Załóż konto"
```
Lokalnie potwierdzenia e-mail trafiają do Inbucket/Mailpit (adres pokazuje `supabase status`).
**Test E1:** załóż dwa konta (dwa okna incognito). W Supabase Studio (`http://127.0.0.1:54323`) → tabela `organizations` ma 2 wiersze; każde konto widzi tylko swoje dane (RLS).

### Etap E2 — ICP
```bash
cp supabase/.env.example supabase/.env     # uzupełnij ANTHROPIC_API_KEY (i resztę kluczy na kolejne etapy)
npx supabase@2.122.1 functions serve --env-file supabase/.env
```
**Test E2:** w aplikacji wpisz np. „palety drewniane EPAL” → pojawia się ICP do edycji. W tabeli `icps` jest wpis, w `api_usage` koszt tokenów. Wpisz bezsensowną frazę wielokrotnie — jeśli model zwróci zły JSON, zobaczysz komunikat, a w `llm_rejections` — powód.

### Etap E3 — Google Places + rejestry PL
Uzupełnij w `supabase/.env`: `GOOGLE_PLACES_API_KEY`, `GUS_BIR_KEY` (lub `GUS_BIR_ENV=test` z kluczem testowym z dokumentacji GUS), opcjonalnie `CEIDG_API_TOKEN`, `BOT_INFO_URL`. Zrestartuj `functions serve`.
**Najpierw** wpisz prawdziwe ceny Google w tabeli `source_pricing` (Studio → Table editor) — inaczej licznik pokaże $0 dla Google.
**Test E3:** wyszukiwanie dla 1 województwa → pasek postępu idzie przez etapy; „Przerwij” zatrzymuje w ciągu kilku sekund. W `api_usage` widać zapytania do `google_places`, `biala_lista`, `gus_bir`, `website`.

### Etap E4 — deduplikacja + scoring
Kod: `core/dedup.ts`, `core/scoring.ts`. Wagi: Ustawienia → „Wagi scoringu” (zapis do `scoring_weights`).
**Test E4:** `npm test` (testy dedup/scoring). W aplikacji: zmień wagę „Dopasowanie branży” na 50 i „Sygnały zakupowe” na 5 → nowe wyszukiwanie → składowe na karcie mają nowe maksima.

### Etap E5 — karta + eksport
**Test E5:** otwórz kartę → „Wygeneruj opis i kąt rozmowy”. Sprawdź: ostrzeżenie art. 398, tabela „Źródła” z datą przy każdym polu, oznaczenia [BRAK DANYCH]/[NIEPEWNE]. „Drukuj / zapisz PDF” → PDF. Na liście wyników „Eksport CSV/XLSX” — kolumna „Źródła pól”, brak treści z Google.

### Etap E6 — filtry
Obowiązkowe (kraj, województwo) i promień od miasta — przy starcie wyszukiwania. Dodatkowe (PKD, forma prawna, status, min. score, tylko z www, tylko z telefonem) — na liście wyników.
**Test E6:** `npm run test:e2e` (sprawdza m.in. region obowiązkowy i filtr min. score) + ręcznie: miasto „Kraków”, promień 30 km → składowa „Lokalizacja” podaje odległość.

### Sprzątanie danych (retencja, wygasanie treści Google)
Uruchom raz w SQL Editorze: [`docs/cron.sql`](docs/cron.sql) (pg_cron co godzinę wywołuje `purge_expired()`).

### Wdrożenie na Supabase (produkcja)
```bash
npx supabase@2.122.1 login
npx supabase@2.122.1 link --project-ref TWÓJ_REF
npx supabase@2.122.1 db push
npx supabase@2.122.1 secrets set --env-file supabase/.env
npx supabase@2.122.1 functions deploy generate-icp
npx supabase@2.122.1 functions deploy run-search
npx supabase@2.122.1 functions deploy lead-card
npm run build                              # katalog dist/ → hosting statyczny (np. Netlify, Vercel, Cloudflare Pages)
```

---

## 4. Scoring (0–100%)

| Składowa | Waga | Jak liczona (tylko z danych) |
|---|---|---|
| Dopasowanie branży | 30 | PKD z rejestru vs PKD z ICP: podklasa 100%, klasa (4 cyfry) 80%, dział (2 cyfry) 50%. Brak PKD → słowa kluczowe w nazwie/typach/www: max 60% i flaga [NIEPEWNE]. |
| Sygnały zakupowe na www | 25 | frazy z ICP znalezione na stronie: 1 → 60%, ≥2 → 100%. Brak www → 0 i [BRAK DANYCH]. |
| Skala | 15 | szacunek z formy prawnej (zawsze [NIEPEWNE]); brak danych → `unknown_scale_factor` (domyślnie 50%). |
| Lokalizacja/logistyka | 10 | w regionie 100%; z promieniem: 100% w centrum → 50% na granicy promienia, poza 20%. |
| Aktywność | 10 | status aktywny/VAT czynny 60% + działa wg Google 20% + strona odpowiada 20%. |
| Kanał kontaktu | 10 | firmowy telefon 50% + rolowy e-mail (biuro@, info@…) 50%. |

Wykluczenie (= 0% z powodem): wykreślona/zlikwidowana/zawieszona, zamknięta wg Google, sygnał wykluczający (np. „produkcja palet”) w nazwie lub na www.
**Pewność danych:** ile kluczowych pól (nazwa, NIP, kod, miejscowość, telefon, www, forma, status) ma tę samą wartość w ≥2 niezależnych źródłach: ≥4 Wysoka, 2–3 Średnia, 0–1 Niska.
Uzasadnienie (1–2 zdania) składa się z powodów wyliczonych przez składowe — LLM go nie pisze.

## 5. Kryteria sukcesu — jak je sprawdzić

| Kryterium | Status / jak sprawdzić |
|---|---|
| ≥30 unikalnych firm w < 5 min | Na mockach: ✅ (test E2E). Na prawdziwych danych: **niezweryfikowane** — zależy od fraz i limitów Biała lista/GUS. Sprawdź w E3 (czas = `finished_at − created_at` w `searches`). |
| ≥70% trafnych leadów ze score ≥60% (próba 20) | Wymaga Twojej ręcznej oceny. Eksportuj CSV, oceń 20 wierszy ze score ≥60; jeśli < 70% — popraw ICP (sygnały/PKD) lub wagi. |
| 0 pól bez źródła | Wymuszone strukturą danych + test jednostkowy i E2E. |
| 0 faktów spoza danych w opisach | Prompt „BRAK DANYCH. Nie zgaduj.” + schemat zod + kontrola liczb i pól dowodowych (`groundingErrors`); odrzucenia w `llm_rejections`. Kontrola jest heurystyczna — przy ocenie 20 leadów czytaj też opisy. |
| Koszt API widoczny w panelu | Pasek postępu + Ustawienia → „Koszty API”. Ceny Google są do uzupełnienia w `source_pricing` (`verified=false`). |

## 6. Ograniczenia MVP (świadome)
- Kolejka działa, dopóki karta przeglądarki jest otwarta (frontend woła „ticki”). Kolejny krok: pg_cron + pg_net wywołujące `run-search`.
- Wyszukiwanie firm tylko przez Google Places — rejestry PL nie pozwalają szukać po PKD+regionie przez publiczne API (BIR, KRS, Biała lista), a dla CEIDG nie wiem, czy i na jakich warunkach wolno — patrz SOURCES.md.
- Kody PKD/NACE proponuje LLM — użytkownik musi je zweryfikować (format jest walidowany, istnienie kodu — nie).
- `npm install` wymaga `legacy-peer-deps` (ustawione w `.npmrc`) z powodu błędu npm przy rozwiązywaniu zależności peer.
