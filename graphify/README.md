# Graphify (lokalnie)

Zamienia folder z notatkami i kodem w interaktywny graf powiązań. Działa offline, bez instalacji
(wymaga tylko Pythona 3). Wszystko leży w tym folderze:

- `vault/` – Twoje notatki (przykładowe; możesz je podmienić swoimi)
- `data/layout.json` – zapamiętane położenie węzłów
- `static/index.html` – interfejs, `graphify.py` – serwer i skaner

## Start
    ./run.sh            # Linux/macOS      |  run.bat  # Windows
    python3 graphify.py /inny/folder --port 8765

## Router AI (jak OmniRoute)
`graphify.py` wystawia lokalny endpoint zgodny z OpenAI: `http://127.0.0.1:8765/v1/chat/completions`
(+ `/v1/models`). Możesz go wpiąć w dowolne narzędzie. Konfiguracja w zakładce **Router**
(`data/providers.json`, tworzony przy pierwszym starcie: Ollama, OpenRouter, OpenAI):
- **trasy** = lista celów `dostawca/model`, strategia `fallback` lub `round_robin`
- automatyczne przełączenie na następny cel przy błędzie + 60 s pauza dla zepsutego dostawcy
- klucze w `api_key` lub w zmiennej środowiskowej (`api_key_env`); plik jest poza gitem
- statystyki (ok/błędy/średni czas) w zakładce Router

## Skille (Agent Skills)
Foldery `skills/<nazwa>/SKILL.md` z frontmatterem `name`/`description`. W zakładce **Czat AI** zaznaczasz,
które skille wchodzą do kontekstu. Wbudowane: `ponytail` (drabinka minimalizmu w kodzie),
`graphify-notes`, `summarize-note`. Foldery działają też w Claude Code (`~/.claude/skills`).

## Czat z grafem
Zakładka **Czat AI** wysyła pytanie przez router, z zaznaczoną notatką i jej sąsiadami jako kontekstem.

## Co wykrywa
- `[[wikilinki]]` i zwykłe linki markdown → krawędzie; brakujące notatki jako „duchy”
- `#tagi` → węzły tagów
- `import` w Pythonie i JS/TS, `href/src` w HTML

## Interfejs
Szukaj, przeciągaj węzły, przybliżaj kółkiem, klik = podgląd i edycja pliku (Zapisz),
„＋ Notatka” tworzy plik `.md`, klik w „ducha” → „Utwórz notatkę”.
Serwer słucha tylko na 127.0.0.1 i nie wychodzi poza wybrany folder.
