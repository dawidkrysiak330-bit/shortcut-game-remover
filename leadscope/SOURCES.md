# Źródła danych

**Uwaga:** środowisko, w którym powstał kod, nie miało dostępu do stron poniżej. Wszystko oznaczone **„ZWERYFIKUJ”**
wpisałem z wiedzy ogólnej — **nie wiem**, czy jest aktualne. Przed produkcją sprawdź w oficjalnej dokumentacji
i wpisz wynik w kolumnie „Sprawdzone (data, kto)”.

Zasada dodawania kolejnych źródeł: nowy adapter (`supabase/functions/_shared/adapters/*.ts`) tylko wtedy, gdy regulamin
źródła pozwala na automatyczne pobieranie i wykorzystanie danych w celu sprzedażowym. **Nie scrapujemy LinkedIn, Google Maps
(poza API), katalogów firm z regulaminem zakazującym scrapowania; nie omijamy CAPTCHA, logowań, paywalli ani limitów.**

## Podsumowanie

| Źródło | Rola | Szukanie po PKD + regionie? | Klucz | Koszt | Przechowywanie w aplikacji | Sprawdzone (data, kto) |
|---|---|---|---|---|---|---|
| Google Places API (New) | wyszukiwanie firm (discovery) | po frazie + okolicy (nie po PKD) | tak | płatne, SKU zależy od pól | trwale tylko `place_id`; reszta: `places_data` z TTL (domyślnie 24 h), bez eksportu | ☐ |
| Biała lista VAT (MF) | weryfikacja: status VAT, REGON, KRS, adres | **nie** (tylko NIP/REGON/rachunek) | nie | bezpłatne, limity dzienne | dane podmiotu (bez rachunków i osób) z retencją leadów | ☐ |
| GUS BIR 1.1 (REGON) | wzbogacenie: PKD, forma prawna, data powstania | **nie** (tylko NIP/REGON/KRS) | tak (bezpłatny) | bezpłatne | j.w. | ☐ |
| API KRS (MS) | wzbogacenie: forma, przedmiot działalności, www | **nie** (tylko nr KRS) | nie | bezpłatne | j.w., bez działu 2 (osoby) | ☐ |
| CEIDG (API hurtowni) | weryfikacja JDG | **nie wiem** → w MVP nie używane do wyszukiwania | tak (token) | bezpłatne | minimum danych, flaga `is_natural_person` | ☐ |
| VIES (KE) | weryfikacja numeru VAT UE | nie | nie | bezpłatne | status ważności | ☐ |
| Strona www firmy | sygnały zakupowe, NIP, e-mail rolowy, telefon z kontaktu | n/d | nie | koszt własny | tekst ≤15 tys. znaków/stronę, z retencją leadów | ☐ |

---

## Google Places API (New) — Text Search
- **Dokumentacja (ZWERYFIKUJ):** https://developers.google.com/maps/documentation/places/web-service/text-search
- **Regulamin:** https://cloud.google.com/maps-platform/terms , Service Specific Terms: https://cloud.google.com/maps-platform/terms/maps-service-terms
  oraz warunki dla klientów z EOG (Google publikuje osobną wersję dla adresów rozliczeniowych w EOG — **sprawdź, która obowiązuje Ciebie i od kiedy**).
- **Endpoint w kodzie:** `POST https://places.googleapis.com/v1/places:searchText`, nagłówki `X-Goog-Api-Key`, `X-Goog-FieldMask`.
  Szczegóły miejsca: `GET https://places.googleapis.com/v1/places/{place_id}`.
- **Limity (ZWERYFIKUJ):** do 20 wyników na stronę, do 3 stron na zapytanie (w kodzie: `MAX_PAGES_PER_QUERY = 3`); limity QPM w konsoli Google Cloud.
- **Koszt (ZWERYFIKUJ):** SKU zależy od pól w field mask — `websiteUri` i `nationalPhoneNumber` zwykle podnoszą SKU do wyższego poziomu.
  Cennik: https://developers.google.com/maps/billing-and-pricing/pricing . **Wpisz ceny w tabeli `source_pricing`** (`google_places/*`), inaczej licznik pokazuje $0.
- **Co i jak długo wolno przechowywać (ZWERYFIKUJ):** z mojej wiedzy: `place_id` można przechowywać bezterminowo; współrzędne — czasowo (historycznie do 30 dni);
  pozostałych treści nie wolno trwale cache'ować. Kod: `place_id` trwale; pozostałe pola w `leads.places_data` z `places_expires_at`
  (sekret `PLACES_CONTENT_TTL_HOURS`, domyślnie 24), czyszczone przez `purge_expired()`. Jeśli warunki nie pozwalają nawet na to — ustaw `0`
  (karta pobierze dane ponownie przyciskiem „Odśwież dane Google”, nie zapisując ich).
- **Atrybucja:** przy danych z Google w UI wyświetlamy „Google Maps” (lista i karta). **Sprawdź aktualne wymagania** (logo/tekst, wyświetlanie bez mapy).
- **Eksport:** treści z Google nie trafiają do CSV/XLSX (tylko `place_id`).

## Biała lista VAT (Wykaz podatników VAT, Ministerstwo Finansów)
- **Dokumentacja (ZWERYFIKUJ):** https://wl-api.mf.gov.pl/
- **Endpoint w kodzie:** `GET https://wl-api.mf.gov.pl/api/search/nip/{nip}?date=YYYY-MM-DD`
- **Limity (ZWERYFIKUJ):** API ma dzienne limity zapytań typu „search” (z mojej wiedzy rzędu kilkudziesięciu–stu dziennie na IP) — **to może
  ograniczyć liczbę wzbogaceń na dzień**. Jeśli limit jest za mały, rozważ plik płaski MF (inne zasady użycia — sprawdź).
- **Szukanie po PKD+regionie:** niemożliwe — nie obchodzimy.
- **Minimalizacja:** nie zapisujemy numerów rachunków, reprezentantów, prokurentów, wspólników.

## GUS BIR 1.1 (REGON)
- **Dokumentacja (ZWERYFIKUJ):** https://api.stat.gov.pl/Home/RegonApi (dokumentacja BIR1.1, środowisko testowe z publicznym kluczem testowym)
- **Klucz:** bezpłatny, na wniosek (opis na stronie powyżej).
- **W kodzie:** SOAP 1.2 — `Zaloguj` → `DaneSzukajPodmioty` (po NIP) → `DanePobierzPelnyRaport` (`BIR11OsPrawna`, `BIR11OsPrawnaPkd`).
  **Nazwy akcji i raportów ZWERYFIKUJ** w aktualnej dokumentacji.
- **Limity (ZWERYFIKUJ):** limit zapytań na sekundę/godzinę dla klucza; w kodzie odstęp 500 ms.
- **Szukanie po PKD+regionie:** niemożliwe — nie obchodzimy.
- **JDG:** nie pobieramy telefonu/e-maila z rejestru (mogą być prywatne).

## API KRS (Ministerstwo Sprawiedliwości)
- **Dokumentacja (ZWERYFIKUJ):** https://prs.ms.gov.pl/krs/openApi
- **Endpoint w kodzie:** `GET https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/{KRS}?rejestr=P&format=json`
- **Szukanie:** tylko po numerze KRS. **Minimalizacja:** pomijamy dział 2 (zarząd, prokurenci) i wspólników.

## CEIDG (Hurtownia danych CEIDG)
- **Dokumentacja (ZWERYFIKUJ):** https://dane.biznes.gov.pl/
- **Endpoint w kodzie:** `GET {CEIDG_API_URL}?nip=…` z `Authorization: Bearer` — **adres, wersja API i kształt odpowiedzi do weryfikacji**
  (adres bazowy jest konfigurowalny sekretem `CEIDG_API_URL`).
- **Szukanie po PKD+regionie:** **nie wiem**, czy aktualne API to umożliwia i czy regulamin pozwala na takie użycie do celów sprzedażowych.
  W MVP wyłączone (`supportsIndustryRegionSearch: false`) — CEIDG służy tylko do weryfikacji po NIP.
- **RODO:** JDG = osoba fizyczna. Patrz COMPLIANCE.md.

## VIES (Komisja Europejska)
- **Dokumentacja (ZWERYFIKUJ):** https://ec.europa.eu/taxation_customs/vies/
- **Endpoint w kodzie:** `POST https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number` — **ZWERYFIKUJ**.
- **Użycie:** weryfikacja numerów VAT UE (adapter gotowy; w MVP dla PL nie jest wywoływany automatycznie, bo Biała lista daje więcej danych).

## Strona www firmy (własny crawler)
- `robots.txt` respektowany (grupa dla `LeadScopeBot`, w przeciwnym razie `*`; najdłuższa reguła wygrywa).
- Jawny User-Agent: `LeadScopeBot/0.1 (+BOT_INFO_URL)` — opublikuj stronę z opisem bota i kontaktem do zgłoszeń/opt-out.
- Max 4 strony na domenę (główna, o nas, oferta, kontakt), 1 zapytanie / 1,5 s na domenę, timeout 10 s, max 600 kB.
- 401/403/429 lub CAPTCHA → przerywamy dla tej domeny (nie obchodzimy).
- Zbieramy: tekst (do sygnałów zakupowych), NIP, **tylko rolowe** e-maile (biuro@, info@…), telefon ze strony kontaktowej.
- Przechowywanie: tekst ≤15 000 znaków na stronę, w `leads.website_pages`, z retencją leadów.
- Uwaga prawna: regulamin konkretnej strony może zakazywać pobierania automatycznego — przy zgłoszeniu dopisz domenę do `suppression_list`.

## Claude API (Anthropic) — przetwarzanie, nie źródło danych — **DOMYŚLNIE WYŁĄCZONE (płatne)**
- Włączane sekretem `AI_ENABLED=true` + `VITE_AI_ENABLED=true`. Bez tego aplikacja nie wysyła nic do Anthropic.
- Model domyślny: `claude-opus-5-5` (cena w `source_pricing`: $4 / $20 za 1 mln tokenów wej./wyj. — stan cennika z 2026-11, zweryfikuj na https://www.anthropic.com/pricing).
- Wysyłamy wyłącznie dane firmy z rejestrów i www (bez danych prywatnych). Sprawdź warunki przetwarzania danych i umowę DPA Anthropic.
