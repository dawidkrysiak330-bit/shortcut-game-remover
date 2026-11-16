# Graphify (lokalnie)

Zamienia folder z notatkami i kodem w interaktywny graf powiązań. Działa offline, bez instalacji
(wymaga tylko Pythona 3). Wszystko leży w tym folderze:

- `vault/` – Twoje notatki (przykładowe; możesz je podmienić swoimi)
- `data/layout.json` – zapamiętane położenie węzłów
- `static/index.html` – interfejs, `graphify.py` – serwer i skaner

## Start
    ./run.sh            # Linux/macOS      |  run.bat  # Windows
    python3 graphify.py /inny/folder --port 8765

## Co wykrywa
- `[[wikilinki]]` i zwykłe linki markdown → krawędzie; brakujące notatki jako „duchy”
- `#tagi` → węzły tagów
- `import` w Pythonie i JS/TS, `href/src` w HTML

## Interfejs
Szukaj, przeciągaj węzły, przybliżaj kółkiem, klik = podgląd i edycja pliku (Zapisz),
„＋ Notatka” tworzy plik `.md`, klik w „ducha” → „Utwórz notatkę”.
Serwer słucha tylko na 127.0.0.1 i nie wychodzi poza wybrany folder.
