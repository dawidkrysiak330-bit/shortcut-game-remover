# Zgodność prawna — co jest wbudowane w produkt

> To nie jest porada prawna. Przed sprzedażą skonsultuj z prawnikiem (RODO, PKE, warunki Google).
> Punkty oznaczone **„ZWERYFIKUJ”** wymagają sprawdzenia aktualnych przepisów/warunków.

## 1. Google Places
| Wymóg | Realizacja w kodzie |
|---|---|
| Tylko oficjalne API, bez scrapowania Map | `adapters/googlePlaces.ts` używa wyłącznie Places API (New). |
| Trwale tylko `place_id` | kolumna `leads.place_id`; pozostałe treści w `leads.places_data` z `places_expires_at`. |
| Odświeżanie z API zamiast budowania bazy | `purge_expired()` czyści `places_data`; karta ma „Odśwież dane Google” (`lead-card` → `refresh_places`), wynik nie jest zapisywany. Brak globalnej bazy firm — dane są per wyszukiwanie i per organizacja. |
| Atrybucja | „Google Maps” przy danych z Google na liście i karcie (`.attribution`). **ZWERYFIKUJ** wymagany wygląd. |
| Brak eksportu treści Google | `src/lib/export.ts` pomija wartości ze źródła `google_places`. |
| Warunki dla klientów z EOG | **ZWERYFIKUJ**: Google ma osobne warunki dla EOG. Sprawdź, czy zmieniają zasady cache'owania/atrybucji i dopasuj `PLACES_CONTENT_TTL_HOURS`. |
| Ryzyko do oceny | Score i uzasadnienie są zapisywane trwale i częściowo pochodzą z danych Google (np. „działa wg Google”). Oceń z prawnikiem, czy to „treść pochodna”; jeśli tak — przelicz score przy odczycie albo usuń składnik Google ze zapisanego uzasadnienia. |

## 2. RODO
**Kluczowe:** JDG z CEIDG/GUS to dane osobowe (nazwa firmy często zawiera imię i nazwisko). Dane spółek nie są danymi osobowymi,
ale imienne e-maile pracowników już tak.

| Zasada | Realizacja |
|---|---|
| Minimalizacja | Tylko dane firmowe. E-maile: wyłącznie rolowe (`isGenericEmail`: biuro@, info@…), imienne są odrzucane. Z rejestrów nie zapisujemy: rachunków bankowych, członków zarządu, prokurentów, wspólników, PESEL, adresów zamieszkania. Dla JDG nie bierzemy telefonu/e-maila z rejestru. |
| Brak profilowania osób fizycznych | Scoring ocenia firmę (działalność gospodarczą), nie osobę; nie łączymy danych z mediami społecznościowymi; nie zbieramy LinkedIn. Rekordy JDG mają flagę `is_natural_person` i ostrzeżenie na karcie. |
| Retencja | `organizations.retention_days` (domyślnie 90) → `leads.expires_at`; `purge_expired()` (pg_cron, `docs/cron.sql`). Dane robocze (`raw_records`) kasowane po zakończeniu wyszukiwania. |
| Usuwanie na żądanie / sprzeciw | Ustawienia → „RODO — usunięcie danych”: `erase_subject()` usuwa leady w organizacji i dodaje NIP (hash SHA-256) lub domenę do `suppression_list` — nie będą zbierane ponownie. Żądanie do operatora SaaS (wszystkie organizacje): `select public.erase_subject_global('NIP', null, 'opis');` w SQL Editorze. |
| Obowiązek informacyjny art. 14 | Szablon dla klienta: [docs/RODO_art14_szablon.md](docs/RODO_art14_szablon.md). Klient wysyła go JDG najpóźniej przy pierwszym kontakcie (lub w ciągu miesiąca od pozyskania danych). |
| Role | **Założenie:** klient = administrator, operator SaaS = podmiot przetwarzający → potrzebna umowa powierzenia (art. 28) i rejestr czynności. **ZWERYFIKUJ z prawnikiem** — przy wspólnej bazie lub własnym celu operatora możesz być współadministratorem. |
| Podstawa prawna | Prawnie uzasadniony interes (art. 6 ust. 1 lit. f) — marketing B2B. Klient powinien mieć test równowagi (LIA). |
| Bezpieczeństwo | RLS na wszystkich tabelach; klucze API tylko w sekretach Edge Functions; tabele robocze bez dostępu dla użytkowników; użytkownik nie może zmienić statusu/kosztu wyszukiwania ani planu. |
| Podprocesorzy | Supabase (hosting bazy — wybierz region UE), Anthropic (LLM), Google. Wpisz ich do umowy powierzenia i polityki prywatności. |

## 3. Prawo komunikacji elektronicznej — art. 398
- Aplikacja **nie wysyła e-maili, SMS-ów i nie dzwoni**. Nie ma takiej funkcji w kodzie.
- Karta leada i eksport XLSX zawierają ostrzeżenie: *pierwszy kontakt marketingowy e-mailem lub telefonem wymaga uprzedniej zgody odbiorcy — także w B2B*.
- Kontakt telefoniczny/e-mailowy w celu marketingu bezpośredniego bez zgody jest niedozwolony; handlowiec może np. wysłać list, spotkać się na targach albo poprosić o zgodę kanałem dozwolonym. **ZWERYFIKUJ** szczegóły z prawnikiem (np. czy zapytanie o zgodę samo w sobie nie jest marketingiem).

## 4. Pozyskiwanie danych — czego NIE robimy
- Nie omijamy CAPTCHA, logowań, paywalli, limitów API (401/403/429 → stop).
- Nie scrapujemy LinkedIn ani Google Maps.
- Szanujemy `robots.txt`, jawny User-Agent, limit zapytań na domenę.
- Rejestry, które nie pozwalają szukać po PKD + regionie, służą tylko do weryfikacji (nie obchodzimy ograniczeń przez masowe odpytywanie po zakresach NIP itp.).

## 5. Jakość danych (wymagania twarde)
- Każda wartość: `source` + `fetched_at` (+ `source_url`) — struktura `FieldValue`, test jednostkowy i E2E.
- LLM: prompt systemowy zawiera „Jeśli informacji nie ma w dostarczonych danych — wpisz BRAK DANYCH. Nie zgaduj.”; odpowiedź = JSON walidowany zod; dodatkowo `groundingErrors()` odrzuca liczby spoza danych i punkty bez pola dowodowego. Odrzucone → `llm_rejections` + karta „BRAK DANYCH”.
- Scoring i uzasadnienie są deterministyczne (bez LLM).
- Domyślnie AI jest wyłączone: karta leada (`core/card.ts`) składa się z dosłownych cytatów z rejestru/www i powodów ze scoringu — każda karta przechodzi tę samą kontrolę `groundingErrors` (test jednostkowy).
