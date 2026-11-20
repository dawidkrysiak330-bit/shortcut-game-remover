# LeadScope Lite (Opcja 1 — wersja bazowa)

Strona w przeglądarce: wpisujesz frazy (jak w wyszukiwarce Map), wybierasz województwo — program:

1. pyta **oficjalne Google Places API** (bez scrapowania Google Maps),
2. usuwa duplikaty (ta sama firma z kilku fraz, ta sama domena/telefon),
3. odwiedza strony www firm (z poszanowaniem `robots.txt`, jawny User-Agent, przerwy między zapytaniami) i zbiera **NIP, rolowy e-mail (biuro@, info@…), telefon ze strony kontaktowej**,
4. opcjonalnie uzupełnia oficjalną nazwę, adres i status VAT z **Białej listy VAT** (po NIP),
5. eksportuje CSV.

Wersja docelowa (ICP z AI, rejestry GUS/KRS, scoring %, karta leada, wielu klientów) jest w katalogu [`../leadscope`](../leadscope). Lite korzysta z jej kodu (normalizacja NIP/telefonu, robots.txt, regiony), więc nic nie trzeba przepisywać przy przejściu.

## Uruchomienie krok po kroku

**Wymagania:** Node.js **22.18 lub nowszy** (https://nodejs.org — wybierz wersję LTS). Sprawdź: `node --version`.
Katalog `leadscope` musi leżeć obok `leadscope-lite` (tak jak w repozytorium).

### Tryb demo (bez klucza, dane fikcyjne)
```bash
cd leadscope-lite
npm run demo
```
Otwórz http://localhost:8787, wpisz frazy, wybierz „małopolskie”, kliknij **Szukaj**.

### Z prawdziwymi danymi
1. Klucz Google: https://console.cloud.google.com/ → utwórz projekt → włącz **Places API (New)** → *Credentials* → *Create API key*.
   Ogranicz klucz do „Places API (New)”. Wymagane jest konto rozliczeniowe.
2. Skopiuj `.env.example` jako `.env` i wklej klucz w `GOOGLE_PLACES_API_KEY`.
3. Sprawdź w cenniku Google cenę jednego zapytania Text Search dla używanych pól (nazwa, adres, telefon, www, ocena — to zwykle wyższy SKU) i wpisz ją w `PLACES_PRICE_PER_REQUEST_USD`. Bez tego licznik kosztów pokaże „nie ustawiono ceny”.
   Cennik: https://developers.google.com/maps/billing-and-pricing/pricing
4. `npm start` → http://localhost:8787

**Koszt jednego wyszukiwania** ≈ liczba fraz × do 3 stron wyników (+1 zapytanie, jeśli podasz miasto) × cena zapytania. Przykład: 5 fraz → do 15–16 zapytań.

### Test
```bash
npm install
npx playwright install chromium
npm test
```
Test działa w trybie demo i sprawdza: region obowiązkowy, ≥30 firm, deduplikację między frazami, respektowanie robots.txt i blokad (403), odrzucanie imiennych e-maili, filtr województwa, eksport bez treści Google, przerwanie wyszukiwania.

## Zasady wbudowane w program
- **Tylko oficjalne API Google.** Żadnego „klikania” w Mapy, omijania CAPTCHA ani limitów.
- **Treści z Google** (nazwa, adres, telefon, ocena z Map) są **tylko do podglądu**, trzymane wyłącznie w pamięci, kasowane po 1 godzinie lub po wyłączeniu programu. **Nie trafiają do eksportu CSV** — eksport zawiera `place_id` i link do Map. Atrybucja „© Google Maps” pod tabelą.
  Warunki przechowywania danych Google **sprawdź w aktualnym regulaminie** (https://cloud.google.com/maps-platform/terms — także wersja dla EOG).
- **Strony www:** `robots.txt` respektowany, User-Agent `LeadScopeLite/0.1 (+BOT_INFO_URL)`, max 4 podstrony na firmę, 1,5 s przerwy, odpowiedź 401/403/429 lub CAPTCHA = rezygnacja.
- **Minimalizacja danych (RODO):** zapisujemy tylko adresy rolowe (biuro@, info@…), imienne (jan.kowalski@) są odrzucane. Z Białej listy nie pobieramy rachunków ani osób.
- **Art. 398 Prawa komunikacji elektronicznej:** program nie wysyła e-maili i nie dzwoni; na stronie jest ostrzeżenie, że pierwszy kontakt marketingowy e-mail/telefon wymaga uprzedniej zgody — także w B2B.
- Serwer nasłuchuje tylko na `localhost` (nie jest dostępny z sieci).

## Ograniczenia
- Google zwraca max ok. 60 wyników na frazę (3 strony × 20) — więcej firm = więcej fraz lub kilka miast. **ZWERYFIKUJ** limit w dokumentacji Places API.
- Biała lista ma dzienne limity zapytań (**ZWERYFIKUJ**: https://wl-api.mf.gov.pl/) — przy dużych wyszukiwaniach część firm może zostać bez uzupełnienia.
- Program nie ocenia trafności (brak scoringu) — to robi wersja docelowa.
- Endpointy i limity opisano z wiedzy ogólnej — środowisko, w którym powstał kod, nie miało dostępu do dokumentacji Google ani MF. Sprawdzone uruchomieniem: tryb demo + testy E2E.
