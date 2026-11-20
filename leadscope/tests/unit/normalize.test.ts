import { describe, expect, it } from "vitest";
import { extractNips, isGenericEmail, isValidNip, normalizeDomain, normalizeName, normalizePhone } from "../../supabase/functions/_shared/core/normalize.ts";
import { isAllowedByRobots } from "../../supabase/functions/_shared/core/web.ts";
import { fakeNip } from "../../src/lib/mockData.ts";

describe("normalizacja", () => {
  it("waliduje NIP sumą kontrolną", () => {
    expect(isValidNip(fakeNip(1))).toBe(true);
    expect(isValidNip("1234567890")).toBe(false);
  });
  it("wyciąga NIP z tekstu w różnych formatach", () => {
    const n = fakeNip(2);
    const dashed = `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6, 8)}-${n.slice(8)}`;
    expect(extractNips(`Dane firmy. NIP: ${dashed}, REGON 123`)).toEqual([n]);
    expect(extractNips("NIP 1234567890")).toEqual([]); // zła suma kontrolna
  });
  it("normalizuje telefon i domenę", () => {
    expect(normalizePhone("+48 12 345 67 89")).toBe("+48123456789");
    expect(normalizePhone("(12) 345-67-89")).toBe("+48123456789");
    expect(normalizeDomain("https://WWW.Firma.pl/kontakt")).toBe("firma.pl");
    expect(normalizeDomain("https://facebook.com/firma")).toBeNull();
  });
  it("przepuszcza tylko rolowe e-maile (minimalizacja danych osobowych)", () => {
    expect(isGenericEmail("biuro@firma.pl")).toBe(true);
    expect(isGenericEmail("info.krakow@firma.pl")).toBe(true);
    expect(isGenericEmail("jan.kowalski@firma.pl")).toBe(false);
    expect(isGenericEmail("j.nowak@firma.pl")).toBe(false);
  });
  it("usuwa formę prawną z nazwy", () => {
    expect(normalizeName("Meble Testowa 05 Sp. z o.o.")).toBe("meble testowa 05");
    expect(normalizeName("MEBLE TESTOWA 05 SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ")).toBe("meble testowa 05");
  });
});

describe("robots.txt", () => {
  const robots = "User-agent: *\nDisallow: /admin\nAllow: /admin/public\n\nUser-agent: LeadScopeBot\nDisallow: /";
  it("stosuje grupę dla naszego bota, jeśli istnieje", () => {
    expect(isAllowedByRobots(robots, "LeadScopeBot/0.1", "/kontakt")).toBe(false);
  });
  it("stosuje grupę * i najdłuższą regułę", () => {
    expect(isAllowedByRobots(robots, "InnyBot/1.0", "/admin/x")).toBe(false);
    expect(isAllowedByRobots(robots, "InnyBot/1.0", "/admin/public/a")).toBe(true);
    expect(isAllowedByRobots(robots, "InnyBot/1.0", "/oferta")).toBe(true);
    expect(isAllowedByRobots(null, "InnyBot/1.0", "/")).toBe(true);
  });
});
