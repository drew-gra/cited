/**
 * Sample article URL discovery for Layer 4.
 *
 * Fallback chain:
 *  1. /sitemap.xml. If a <sitemapindex>, pick a sub-sitemap (news/post/article
 *     in the URL wins; otherwise the most recently modified). Recursion depth
 *     is capped at 2 to defend against circular index references.
 *  2. Common alternates: /sitemap_index.xml, /sitemap-index.xml, /wp-sitemap.xml.
 *  3. RSS / Atom: /feed/, /rss, /atom.xml, /feed.xml.
 *  4. Homepage scrape: extract internal anchor hrefs and filter for
 *     article-shaped paths.
 *
 * Selection heuristic: the two most-recent entries (by <lastmod>/<pubDate>,
 * falling back to document order when timestamps are absent) plus three
 * random samples from the remainder. Total cap of five URLs.
 *
 * Sitemap parsing uses regex rather than an XML parser. Sitemaps are
 * mechanically generated and conform to a narrow schema; regex is sufficient
 * and avoids shipping an XML dependency.
 *
 * Discovery fetches use BASELINE_USER_AGENT (a browser UA), not our
 * AICitabilityBot UA. Discovery is bootstrap work — we just need URLs to
 * probe — and using a bot UA here causes UA-keyed WAFs to drop us before
 * the comparison phase even runs, producing a false "no URLs found"
 * instead of a real `blocked` verdict from the probe phase. The probe
 * phase in ua-probing.ts still uses the distinct browser + bot UAs, so
 * the actual comparison remains clean.
 */

import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { BASELINE_USER_AGENT } from "../policy";

export const sitemapSourceSchema = z.enum([
  "sitemap",
  "rss",
  "homepage",
  "none",
]);

export const sitemapDiscoveryResultSchema = z.object({
  urls: z.array(z.string()),
  source: sitemapSourceSchema,
  sourceUrl: z.string().nullable(),
});

export type SitemapSource = z.infer<typeof sitemapSourceSchema>;
export type SitemapDiscoveryResult = z.infer<typeof sitemapDiscoveryResultSchema>;

const SAMPLE_URLS_TARGET = 5;
const RECENT_COUNT = 2;
const MAX_INDEX_DEPTH = 2;

// Discovery uses a tighter timeout than the L4 probe phase. Discovery is
// bootstrap work — we just need to find article URLs to probe — and
// publishers with aggressive edge protection (NPR, etc.) often tarpit
// sitemap fetches the same way they tarpit article fetches. Waiting the
// full L4 timeout per sitemap URL multiplies discovery wall-clock without
// improving outcomes; 3s is enough to give a fast server a chance and
// bail quickly on tarpits.
const SITEMAP_FETCH_TIMEOUT_MS = 3_000;

// Publishers like NPR declare ten or more Sitemap: directives in their
// robots.txt. When their edge tarpits sitemap URLs, trying all of them
// just burns wall-clock — the pattern is clear after a few failures.
// After this many attempts, fall through to standard paths / RSS /
// homepage scrape. Most well-behaved publishers declare 1-3 sitemaps,
// so this cap doesn't penalize them.
const MAX_ROBOTS_SITEMAPS_TO_TRY = 3;

const SITEMAP_PATHS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/wp-sitemap.xml",
];

const RSS_PATHS = ["/feed/", "/feed", "/rss", "/rss.xml", "/atom.xml", "/feed.xml"];

const URL_ENTRY_RE = /<url\b[^>]*>([\s\S]*?)<\/url>/gi;
const SITEMAP_ENTRY_RE = /<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi;
const SITEMAPINDEX_RE = /<sitemapindex\b/i;
const LOC_RE = /<loc>\s*([^<]+?)\s*<\/loc>/i;
const LASTMOD_RE = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i;
const RSS_ITEM_RE = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
const RSS_LINK_RE = /<link>\s*([^<]+?)\s*<\/link>/i;
const RSS_PUBDATE_RE = /<pubDate>\s*([^<]+?)\s*<\/pubDate>/i;
const ATOM_ENTRY_RE = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
const ATOM_LINK_RE = /<link\b[^>]*href=["']([^"']+)["']/i;
const ATOM_UPDATED_RE = /<updated>\s*([^<]+?)\s*<\/updated>/i;
const ANCHOR_RE = /<a\b[^>]*href=["']([^"']+)["']/gi;

type SitemapEntry = { loc: string; lastmod: string | null };

async function fetchTextWithGzip(
  url: string,
): Promise<{ status: number; text: string | null; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BASELINE_USER_AGENT,
        "Accept-Encoding": "gzip",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(SITEMAP_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { status: res.status, text: null };
    const buf = Buffer.from(await res.arrayBuffer());
    // Some servers serve .xml.gz as raw octet-stream without Content-Encoding;
    // the runtime won't auto-decompress those. Sniff the gzip magic bytes
    // and decompress manually when present.
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      try {
        return { status: res.status, text: gunzipSync(buf).toString("utf-8") };
      } catch (err) {
        return {
          status: res.status,
          text: null,
          error: `gunzip failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    return { status: res.status, text: buf.toString("utf-8") };
  } catch (err) {
    return {
      status: 0,
      text: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseSitemap(xml: string): {
  type: "index" | "urlset" | "unknown";
  entries: SitemapEntry[];
} {
  const isIndex = SITEMAPINDEX_RE.test(xml);
  const entries: SitemapEntry[] = [];
  const re = isIndex ? SITEMAP_ENTRY_RE : URL_ENTRY_RE;
  for (const m of xml.matchAll(re)) {
    const inner = m[1];
    const locMatch = inner.match(LOC_RE);
    if (!locMatch) continue;
    const lastmodMatch = inner.match(LASTMOD_RE);
    entries.push({
      loc: locMatch[1],
      lastmod: lastmodMatch ? lastmodMatch[1] : null,
    });
  }
  if (entries.length === 0) return { type: "unknown", entries: [] };
  return { type: isIndex ? "index" : "urlset", entries };
}

// Sub-sitemaps whose URL signals they hold non-article content. These often
// appear in a publisher's sitemap index but their entries are stale (old
// newsletters), low-value for L4 comparison (videos / galleries), or
// non-editorial (press releases). Probing URLs from one of these usually
// yields baseline-fetch failures or comparison noise that masks the real
// AI-access verdict.
const NON_ARTICLE_SUBSITEMAP_RE =
  /\/(?:eletter|newsletter|podcast|archive|press[-_]?release|video|gallery|tag|category|author)/i;

// Some sitemap-generator plugins (notably Google XML Sitemap Generator
// on WordPress, used by msmagazine.com and others) batch posts into
// `post-sitemap.xml`, `post-sitemap2.xml`, ... `post-sitemapN.xml`,
// with the OLDEST posts in the unnumbered file and the NEWEST in the
// highest-numbered file. All sub-sitemaps share the same `lastmod`
// (the index regeneration time), so a plain lastmod sort ends up
// returning oldest-first on these sites. Extracting the trailing
// numeric suffix lets us break the tie in favor of newer batches.
function trailingSitemapNumber(url: string): number {
  const m = url.match(/(\d+)\.xml(?:\.gz)?(?:[?#].*)?$/i);
  return m ? parseInt(m[1], 10) : 0;
}

function pickSubSitemap(subs: SitemapEntry[]): SitemapEntry | null {
  if (subs.length === 0) return null;
  // First, eliminate sub-sitemaps that hold non-article content. Fall back
  // to the full list only if every candidate is non-article (e.g. a site
  // whose sitemap index is exclusively newsletter archives).
  const articleLike = subs.filter(
    (s) => !NON_ARTICLE_SUBSITEMAP_RE.test(s.loc),
  );
  const pool = articleLike.length > 0 ? articleLike : subs;
  // Within the article-like pool, prefer sub-sitemaps whose URL contains a
  // positive content keyword. "story" is added alongside the original three
  // because many publishers use it (cnn.com/sitemap-stories.xml, etc.).
  const positiveSignal = pool.filter((s) =>
    /news|post|article|story/i.test(s.loc),
  );
  const candidates = positiveSignal.length > 0 ? positiveSignal : pool;
  const sorted = [...candidates].sort((a, b) => {
    if (a.lastmod && b.lastmod) {
      const lc = b.lastmod.localeCompare(a.lastmod);
      if (lc !== 0) return lc;
    } else if (a.lastmod) return -1;
    else if (b.lastmod) return 1;
    // Tiebreaker: highest numeric suffix wins. Handles the
    // `post-sitemap.xml` → `post-sitemap10.xml` ordering case where
    // every sub-sitemap shares a lastmod and the newest content lives
    // in the highest-numbered file.
    return trailingSitemapNumber(b.loc) - trailingSitemapNumber(a.loc);
  });
  return sorted[0];
}

async function discoverViaSitemapPath(
  rootDomain: string,
  path: string,
  depth: number,
): Promise<{ entries: SitemapEntry[]; sourceUrl: string } | null> {
  const url = `https://${rootDomain}${path}`;
  const { text } = await fetchTextWithGzip(url);
  if (!text) return null;
  return resolveSitemap(text, url, depth);
}

async function resolveSitemap(
  xml: string,
  fromUrl: string,
  depth: number,
): Promise<{ entries: SitemapEntry[]; sourceUrl: string } | null> {
  const parsed = parseSitemap(xml);
  if (parsed.type === "urlset" && parsed.entries.length > 0) {
    return { entries: parsed.entries, sourceUrl: fromUrl };
  }
  if (parsed.type === "index" && parsed.entries.length > 0 && depth < MAX_INDEX_DEPTH) {
    const pick = pickSubSitemap(parsed.entries);
    if (!pick) return null;
    // Brief politeness pause before fetching the sub-sitemap (same domain).
    await new Promise((r) => setTimeout(r, 1000));
    const { text } = await fetchTextWithGzip(pick.loc);
    if (!text) return null;
    return resolveSitemap(text, pick.loc, depth + 1);
  }
  return null;
}

function parseRss(xml: string): SitemapEntry[] {
  const items: SitemapEntry[] = [];
  for (const m of xml.matchAll(RSS_ITEM_RE)) {
    const inner = m[1];
    const linkMatch = inner.match(RSS_LINK_RE);
    if (!linkMatch) continue;
    const pubMatch = inner.match(RSS_PUBDATE_RE);
    items.push({
      loc: linkMatch[1],
      lastmod: pubMatch ? pubMatch[1] : null,
    });
  }
  if (items.length > 0) return items;
  for (const m of xml.matchAll(ATOM_ENTRY_RE)) {
    const inner = m[1];
    const linkMatch = inner.match(ATOM_LINK_RE);
    if (!linkMatch) continue;
    const updMatch = inner.match(ATOM_UPDATED_RE);
    items.push({
      loc: linkMatch[1],
      lastmod: updMatch ? updMatch[1] : null,
    });
  }
  return items;
}

const NON_ARTICLE_PATH_RE =
  /\/(?:category|categories|tag|tags|author|authors|page|wp-admin|wp-content|wp-login|wp-json|feed|rss|search|about|contact|privacy|terms|subscribe|login|signup|register|cart|checkout|sections?|podcasts?|newsletters?|topics?|series|shows?|channels?|programs?)\b/i;
const ASSET_EXT_RE =
  /\.(?:css|js|json|jpg|jpeg|png|gif|svg|ico|webp|pdf|xml|zip|gz|mp4|mp3)$/i;

function scrapeHomepageLinks(html: string, rootDomain: string): SitemapEntry[] {
  const links = new Set<string>();
  const head = html.slice(0, 512 * 1024);
  for (const m of head.matchAll(ANCHOR_RE)) {
    const href = m[1];
    let u: URL;
    try {
      u = new URL(href, `https://${rootDomain}/`);
    } catch {
      continue;
    }
    const host = u.hostname.replace(/^www\./, "");
    if (host !== rootDomain) continue;
    const path = u.pathname;
    if (path === "/" || path === "") continue;
    if (NON_ARTICLE_PATH_RE.test(path)) continue;
    if (ASSET_EXT_RE.test(path)) continue;
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    links.add(`https://${host}${path}`);
  }
  return Array.from(links).map((loc) => ({ loc, lastmod: null }));
}

function sampleRandom<T>(arr: T[], n: number): T[] {
  if (n >= arr.length) return [...arr];
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

function selectSample(entries: SitemapEntry[]): string[] {
  if (entries.length === 0) return [];
  const deduped = Array.from(
    new Map(entries.map((e) => [e.loc, e])).values(),
  );
  if (deduped.length <= SAMPLE_URLS_TARGET) return deduped.map((e) => e.loc);

  const sorted = [...deduped].sort((a, b) => {
    if (a.lastmod && b.lastmod) return b.lastmod.localeCompare(a.lastmod);
    if (a.lastmod) return -1;
    if (b.lastmod) return 1;
    return 0;
  });
  const recent = sorted.slice(0, RECENT_COUNT).map((e) => e.loc);
  const rest = sorted.slice(RECENT_COUNT);
  const sampled = sampleRandom(rest, SAMPLE_URLS_TARGET - recent.length).map(
    (e) => e.loc,
  );
  return [...recent, ...sampled];
}

function isValidSitemapUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export type FindSampleOptions = {
  /**
   * Sitemap URLs declared in robots.txt (`Sitemap:` directives). Tried
   * before the standard `/sitemap.xml`-style guesses because the publisher
   * has explicitly told us where their sitemap lives. Required for
   * publishers like NPR whose sitemaps live at non-standard paths
   * (`/sitemap_1.xml`, `/sitemap_2.xml`, ...) that our default guesses
   * would miss.
   */
  robotsSitemaps?: string[];
};

export async function findSampleArticleUrls(
  rootDomain: string,
  options?: FindSampleOptions,
): Promise<SitemapDiscoveryResult> {
  if (options?.robotsSitemaps) {
    const sitemapsToTry = options.robotsSitemaps.slice(
      0,
      MAX_ROBOTS_SITEMAPS_TO_TRY,
    );
    for (const url of sitemapsToTry) {
      if (!isValidSitemapUrl(url)) continue;
      const { text } = await fetchTextWithGzip(url);
      if (!text) continue;
      const found = await resolveSitemap(text, url, 0);
      if (found && found.entries.length > 0) {
        return {
          urls: selectSample(found.entries),
          source: "sitemap",
          sourceUrl: found.sourceUrl,
        };
      }
    }
  }

  for (const path of SITEMAP_PATHS) {
    const found = await discoverViaSitemapPath(rootDomain, path, 0);
    if (found && found.entries.length > 0) {
      return {
        urls: selectSample(found.entries),
        source: "sitemap",
        sourceUrl: found.sourceUrl,
      };
    }
  }

  for (const path of RSS_PATHS) {
    const url = `https://${rootDomain}${path}`;
    const { text } = await fetchTextWithGzip(url);
    if (!text) continue;
    const entries = parseRss(text);
    if (entries.length > 0) {
      return {
        urls: selectSample(entries),
        source: "rss",
        sourceUrl: url,
      };
    }
  }

  const homepageUrl = `https://${rootDomain}/`;
  const { text } = await fetchTextWithGzip(homepageUrl);
  if (text) {
    const entries = scrapeHomepageLinks(text, rootDomain);
    if (entries.length > 0) {
      return {
        urls: selectSample(entries),
        source: "homepage",
        sourceUrl: homepageUrl,
      };
    }
  }

  return { urls: [], source: "none", sourceUrl: null };
}
