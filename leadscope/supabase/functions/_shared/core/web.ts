// =============================================================
// Pomocnicze funkcje dla adaptera stron www:
// - parser robots.txt (uproszczony, zgodny z RFC 9309 w zakresie Allow/Disallow i "*")
// - zamiana HTML na tekst
// - wybór podstron (o nas, oferta, kontakt)
// =============================================================

interface Group { agents: string[]; rules: { allow: boolean; path: string }[] }

function parseRobots(txt: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      if (value !== "" || key === "allow") current.rules.push({ allow: key === "allow", path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function ruleMatches(rulePath: string, path: string): boolean {
  if (rulePath === "") return false;
  const esc = rulePath.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const re = esc.endsWith("\\$") ? new RegExp("^" + esc.slice(0, -2) + "$") : new RegExp("^" + esc);
  return re.test(path);
}

/**
 * Czy `path` wolno pobrać dla bota `userAgent`?
 * Wybieramy grupę dla naszego bota, a gdy jej brak — grupę "*".
 * Wygrywa najdłuższa pasująca reguła; przy remisie Allow.
 */
export function isAllowedByRobots(robotsTxt: string | null, userAgent: string, path: string): boolean {
  if (!robotsTxt) return true;
  const groups = parseRobots(robotsTxt);
  const token = userAgent.toLowerCase().split("/")[0];
  const group = groups.find((g) => g.agents.some((a) => a !== "*" && token.includes(a))) ?? groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    if (ruleMatches(r.path, path)) {
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
    }
  }
  return best ? best.allow : true;
}

/** Bardzo prosta zamiana HTML → tekst (bez skryptów, stylów, nawigacji). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer-nav)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

const SUBPAGE_PATTERNS = [
  /o-nas|o_nas|onas|about|o-firmie|firma/i,
  /oferta|offer|produkty|products|uslugi|services/i,
  /kontakt|contact/i,
];

/** Z HTML strony głównej wybiera max 3 linki (o nas, oferta, kontakt) w tej samej domenie. */
export function pickSubpages(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const links = [...html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)].map((m) => m[1]);
  const out: string[] = [];
  for (const pat of SUBPAGE_PATTERNS) {
    for (const href of links) {
      try {
        const u = new URL(href, base);
        if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) continue;
        if (pat.test(u.pathname) && !out.includes(u.href)) { out.push(u.href); break; }
      } catch { /* zły link — pomijamy */ }
    }
  }
  return out.slice(0, 3);
}
