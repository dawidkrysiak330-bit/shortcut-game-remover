// =============================================================
// Twardy miesięczny limit zapytań do Google Places — żeby korzystać tylko z darmowej puli.
// Licznik zapisujemy w pliku .usage.json (tylko liczba zapytań, żadnych danych Google).
// Domyślnie 900/mies. — margines poniżej darmowej puli dla zapytań z polami www/telefon
// (z pamięci: ok. 1000/mies. dla kategorii Enterprise — ZWERYFIKUJ w konsoli Google).
// =============================================================
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Quota {
  /** Rezerwuje 1 zapytanie. Zwraca false, jeśli limit miesięczny został wyczerpany. */
  take(): boolean;
  status(): { month: string; used: number; limit: number; remaining: number };
}

const month = () => new Date().toISOString().slice(0, 7);

export function fileQuota(path: string, limit: number): Quota {
  let state = { month: month(), used: 0 };
  if (existsSync(path)) {
    try { state = JSON.parse(readFileSync(path, "utf-8")); } catch { /* uszkodzony plik — zaczynamy od nowa, ale ostrożnie */ }
  }
  const roll = () => { if (state.month !== month()) state = { month: month(), used: 0 }; };
  return {
    take() {
      roll();
      if (state.used >= limit) return false;
      state.used++;
      writeFileSync(path, JSON.stringify(state)); // zapis od razu — licznik przetrwa restart programu
      return true;
    },
    status() { roll(); return { month: state.month, used: state.used, limit, remaining: Math.max(0, limit - state.used) }; },
  };
}

/** Tryb demo: licznik tylko w pamięci. */
export function memoryQuota(limit: number): Quota {
  let used = 0;
  return {
    take() { if (used >= limit) return false; used++; return true; },
    status() { return { month: month(), used, limit, remaining: Math.max(0, limit - used) }; },
  };
}
