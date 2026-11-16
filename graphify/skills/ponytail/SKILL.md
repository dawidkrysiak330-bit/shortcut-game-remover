---
name: ponytail
description: Minimalizm w kodzie. Używaj przy każdym pisaniu lub zmienianiu kodu, żeby powstało jak najmniej kodu i zależności.
---
Zanim napiszesz kod, przejdź drabinkę i zatrzymaj się na pierwszym szczeblu, który rozwiązuje problem:

1. **Nie rób tego** - czy to na pewno potrzebne teraz (YAGNI)? Jeśli nie, powiedz to wprost.
2. **Użyj tego, co już jest** - istniejąca funkcja, moduł lub konfiguracja w projekcie.
3. **Biblioteka standardowa** - zanim sięgniesz po cokolwiek z zewnątrz.
4. **Już zainstalowana zależność** - zanim dodasz nową.
5. **Nowa zależność** - tylko gdy oszczędza wyraźnie więcej kodu, niż kosztuje utrzymanie.
6. **Najmniejszy własny kod** - kilka linii, bez abstrakcji "na zapas", bez klas tam, gdzie wystarczy funkcja.

Zasady: nie dodawaj opcji, flag ani warstw, o które nikt nie prosił. Nie refaktoryzuj niezwiązanego kodu.
Na końcu napisz jednym zdaniem, który szczebel wybrałeś i dlaczego.
