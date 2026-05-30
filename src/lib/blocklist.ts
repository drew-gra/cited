/**
 * Suffix-matching domain check against the manual L0 blocklist. Kept as a
 * pure function with no DB or fetch dependencies so it can be reused from
 * runPreflight (write time) and the API routes (read time) without dragging
 * either side into a coupling on db/queries.ts.
 *
 * Match semantics: a candidate matches an entry if it equals the entry OR
 * is a subdomain of it. Adding "examplepropaganda.com" therefore blocks
 * both itself and "news.examplepropaganda.com" — outlets can't route
 * around the block by switching subdomains. A bare prefix like
 * "notexample.com" does NOT match an entry "example.com": only
 * boundary-delimited subdomains (".example.com") match.
 *
 * Case-insensitive (DNS is case-insensitive).
 */
export function isBlocked(candidate: string, blocklist: string[]): boolean {
  const lower = candidate.toLowerCase();
  for (const raw of blocklist) {
    const entry = raw.toLowerCase();
    if (!entry) continue;
    if (lower === entry) return true;
    if (lower.endsWith(`.${entry}`)) return true;
  }
  return false;
}
