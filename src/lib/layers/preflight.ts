/**
 * Layer 0 — Preflight: is this a real news outlet?
 *
 * Cited is a tool for assessing news-outlet AI accessibility. If the
 * submitted URL isn't a news outlet, the L1-L5 verdicts are noise at
 * best and misleading at worst (an e-commerce site's robots.txt or
 * CDN posture is not interesting). Preflight is the gate that decides
 * whether the rest of the pipeline runs.
 *
 * Approach: a scored ensemble of independent signals. Each signal
 * contributes a small positive or negative delta to a running score;
 * thresholds map the score to {news, borderline, not_news}. This is
 * rule-based rather than learned because we have no ground-truth
 * labels yet, and because rule-based decisions are explainable in the
 * UI ("5 of 8 news signals present" beats "model output 0.73").
 *
 * Signals collected:
 *   Homepage (1 fetch):
 *     - <meta name="generator"> for hosting-platform identity.
 *     - og:site_name (used by Wikipedia lookup as the search term).
 *     - og:type (article = mild positive; product = strong negative).
 *     - Section navigation breadth (politics/business/sports/etc.).
 *     - Newsroom-page links (about/staff/corrections/ethics).
 *     - Commerce fingerprints (Shopify / WooCommerce / cart elements).
 *
 *   Article samples (up to 3 fetches, reuses sitemap discovery):
 *     - JSON-LD @type of NewsArticle / ReportageNewsArticle / Article.
 *     - Author signals across the metadata + class-name tiers.
 *     - Published-date metadata (article:published_time, schema.org).
 *
 *   Wikipedia lookup (1 external API call):
 *     - Does Wikipedia have an article that references this domain?
 *
 * Platform override: Substack, Beehiiv, and Ghost require material
 * infrastructure investment to set up, so the corporate-marketing
 * false-positive case Cited is trying to filter doesn't really happen
 * there. Detected newsletter platforms get a hard override to "news"
 * regardless of score (handled in preflight-verdicts.ts).
 *
 * All fetches use the baseline browser UA — preflight is bootstrap
 * work and we don't want UA-keyed WAFs to false-negative this layer
 * the way they could false-negative L4.
 */

import { z } from "zod";
import { BASELINE_USER_AGENT, POLITENESS } from "../policy";
import { findSampleArticleUrls, sitemapSourceSchema } from "./sitemap";
import {
  lookupWikipedia,
  wikipediaLookupResultSchema,
  type WikipediaLookupResult,
} from "./wikipedia";
import {
  preflightReasonSchema,
  type PreflightReason,
} from "../preflight-verdicts";

const PREFLIGHT_FETCH_TIMEOUT_MS = 6_000;
const PREFLIGHT_ARTICLE_SAMPLE_SIZE = 3;
const RECENT_ARTICLE_WINDOW_DAYS = 60;

export const platformHintSchema = z.enum([
  "substack",
  "beehiiv",
  "ghost",
  "wordpress",
  "wix",
  "squarespace",
]);

export const preflightHomepageSchema = z.object({
  fetchedUrl: z.string(),
  status: z.enum(["ok", "error"]),
  httpStatus: z.number().nullable(),
  errorMessage: z.string().optional(),
  ogSiteName: z.string().nullable(),
  ogType: z.string().nullable(),
  metaGenerator: z.string().nullable(),
  sectionNavCount: z.number(),
  sectionNavSamples: z.array(z.string()),
  newsroomLinkCount: z.number(),
  newsroomLinkSamples: z.array(z.string()),
  commerceFingerprints: z.array(z.string()),
});

export const preflightArticlesSchema = z.object({
  source: sitemapSourceSchema,
  sampledUrls: z.array(z.string()),
  fetchCount: z.number(),
  jsonLdNewsArticleCount: z.number(),
  jsonLdGenericArticleCount: z.number(),
  distinctBylines: z.array(z.string()),
  authorMetaTagHits: z.number(),
  recentArticleCount: z.number(),
});

// Runtime schema for the persisted L0 signal. Source of truth.
export const preflightSignalSchema = z.object({
  rootDomain: z.string(),
  fetchedAt: z.string(),
  status: z.enum(["ok", "error"]),
  errorMessage: z.string().optional(),
  homepage: preflightHomepageSchema,
  articles: preflightArticlesSchema,
  wikipedia: wikipediaLookupResultSchema.nullable(),
  platform: platformHintSchema.nullable(),
  newsletterPlatformOverride: z.boolean(),
  socialPlatformDenied: z.boolean(),
  score: z.number(),
  reasons: z.array(preflightReasonSchema),
});

export type PlatformHint = z.infer<typeof platformHintSchema>;
export type PreflightHomepage = z.infer<typeof preflightHomepageSchema>;
export type PreflightArticles = z.infer<typeof preflightArticlesSchema>;
export type PreflightSignal = z.infer<typeof preflightSignalSchema>;

const NEWSLETTER_PLATFORMS: ReadonlySet<PlatformHint> = new Set([
  "substack",
  "beehiiv",
  "ghost",
]);

// Domains Cited categorically refuses to assess. These are
// user-generated-content platforms whose HTML can superficially look
// news-shaped — Reddit threads have bylines (usernames), recent
// activity, and structured schema; X posts have author metadata; etc.
// But they aren't editorial publications, and a green verdict on a
// Reddit thread would be misleading regardless of what the signals
// say. Hard-red is the only honest answer.
//
// Deliberately NOT included: publishing platforms (medium.com,
// substack.com, beehiiv.com, ghost.org) — those host real publications
// on subdomains and custom domains, and the existing newsletter-
// platform override handles editorial use correctly.
const SOCIAL_PLATFORM_DENYLIST: ReadonlySet<string> = new Set([
  // UGC / social networks
  "reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "np.reddit.com",
  "twitter.com",
  "x.com",
  "mobile.twitter.com",
  "facebook.com",
  "m.facebook.com",
  "instagram.com",
  "threads.net",
  "tiktok.com",
  "youtube.com",
  "m.youtube.com",
  "youtu.be",
  "linkedin.com",
  "pinterest.com",
  "tumblr.com",
  "bsky.app",
  "mastodon.social",
  "snapchat.com",
  // Discussion / aggregators
  "news.ycombinator.com",
  "digg.com",
  "flipboard.com",
  // Image / video sharing
  "imgur.com",
]);

// Paths that look like first-segments but aren't editorial sections.
// We deliberately don't ship a positive list of section names because
// that bakes in a general-news vocabulary that misses vertical
// publications (cannabis, crypto, climate, legal/trade press) whose
// sections use domain-specific terms. Instead we measure structural
// shape: a real section is a path used as a navigation category, which
// shows up as repeated homepage anchors sharing a first-segment.
//
// Editorial sections that share a name with a denylist entry (rare —
// e.g. a publication whose section happens to be called "Search") will
// be missed, but the cost of missing them is much lower than the cost
// of the keyword-list approach silently zeroing this signal on every
// vertical publication.
const NON_SECTION_PATHS: ReadonlySet<string> = new Set([
  // Site infrastructure
  "search",
  "sitemap",
  "sitemap_index",
  "robots.txt",
  "feed",
  "feeds",
  "rss",
  "atom",
  "api",
  "amp",
  // WordPress internals
  "wp-admin",
  "wp-login",
  "wp-content",
  "wp-includes",
  "wp-json",
  // Static assets
  "assets",
  "static",
  "public",
  "css",
  "js",
  "fonts",
  "images",
  "img",
  "media",
  // User account / auth
  "account",
  "accounts",
  "login",
  "signin",
  "sign-in",
  "signup",
  "sign-up",
  "register",
  "logout",
  "profile",
  "settings",
  "dashboard",
  "preferences",
  "my",
  // Commerce
  "cart",
  "checkout",
  "order",
  "orders",
  "basket",
  "billing",
  // Legal / policy / utility
  "privacy",
  "privacy-policy",
  "terms",
  "terms-of-service",
  "legal",
  "cookies",
  "cookie-policy",
  "dmca",
  "disclaimer",
  "accessibility",
  "404",
  "500",
  "error",
  // Meta-navigation (browse-by pages, not sections themselves)
  "tag",
  "tags",
  "category",
  "categories",
  "author",
  "authors",
  "page",
  "archive",
  "archives",
  // Generic newsroom-page paths (separate signal, not section nav)
  "about",
  "about-us",
  "contact",
  "contact-us",
  "support",
  "help",
  "faq",
]);

// A first-segment must appear in at least this many distinct homepage
// anchors before it's treated as a section. Real nav categories show
// up in header + footer + inline "more from X" patterns; one-off
// article links don't.
const MIN_SECTION_ANCHOR_OCCURRENCES = 2;

// Default / uncustomized og:site_name values. Real publications brand
// the field; corporate blogs leave whatever the CMS template set. A
// generic value is a strong corporate-content tell — strong enough that
// when other negative signals don't fire, the verdict can still flip
// correctly to not-news (case study: blog.turbotax.intuit.com whose
// og:site_name is literally "Blog").
const GENERIC_SITE_NAMES: ReadonlySet<string> = new Set([
  "blog",
  "site",
  "website",
  "default",
  "untitled",
  "home",
  "homepage",
  "my site",
  "my blog",
]);

// `blog.<something>` almost always signals corporate-content publishing
// rather than a primary news property. The risk is false-negativing a
// topical sub-blog of a real outlet (NYT used "blog.nytimes.com" for
// The Caucus once upon a time); the counter weight is mild enough that
// a real publication can still clear with NewsArticle + bylines +
// cadence + section nav. Deliberately NOT including "news.": that
// prefix is genuinely ambiguous (news.yahoo.com, news.com historically).
const CORPORATE_BLOG_SUBDOMAIN_PREFIX = "blog.";

// Cap for anchor/nav scanning. Meta-tag extraction uses a much smaller
// slice (256KB) because meta tags live in <head>, but nav links and
// section anchors can sit anywhere on the page — and on heavy WordPress
// homepages (Marijuana Moment is 559KB, mostly article cards), the nav
// can land entirely past the first 256KB. 2MB protects against
// pathological pages while comfortably covering all the publishers
// we've tested.
const NAV_SCAN_MAX_BYTES = 2 * 1024 * 1024;

// Pages an editorial operation typically maintains. Single hits are
// weak; multiple together is a strong newsroom signal.
const NEWSROOM_LINK_PATHS = [
  "/about",
  "/staff",
  "/masthead",
  "/team",
  "/contact",
  "/corrections",
  "/ethics",
  "/editorial",
  "/standards",
  "/newsroom",
  "/contributors",
];

const COMMERCE_SIGNATURES: Array<{ id: string; re: RegExp }> = [
  { id: "shopify", re: /cdn\.shopify\.com|shopify-section|x-shopify-stage|<meta\s+name=["']shopify[^"']*["']/i },
  { id: "woocommerce", re: /\/wp-content\/plugins\/woocommerce|class=["'][^"']*woocommerce-/i },
  { id: "bigcommerce", re: /cdn1?1?\.bigcommerce\.com|bigcommerce/i },
  { id: "magento", re: /data-mage-init=|mage\/cookies/i },
  { id: "squarespace-commerce", re: /sqs-block-product|squarespace-commerce/i },
];

const META_TAG_RE = /<meta\b[^>]*>/gi;
const META_NAME_RE = /\b(?:name|property)=["']([^"']+)["']/i;
const META_CONTENT_RE = /\bcontent=["']([^"']*)["']/i;
const ANCHOR_RE = /<a\b[^>]*href=["']([^"']+)["']/gi;
const JSON_LD_RE =
  /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
// Spec-correct HTML5 way to mark up a publish date. Many WordPress
// themes (and most modern publication CMSes) emit only this — no
// meta tags, no JSON-LD datePublished — so an article-date extractor
// that ignores it produces false negatives for the recent-cadence
// signal on real outlets that publish constantly.
const TIME_DATETIME_RE = /<time\b[^>]*\bdatetime=["']([^"']+)["']/i;
// Class-name byline detection — see the byline-detection notes in the
// preflight design conversation. The fourth tier (HTML class heuristics)
// catches publications that visually credit a reporter with no "By" prefix
// but still wrap the name in <span class="byline"> / <a class="author">.
const BYLINE_CLASS_RE =
  /<(?:span|a|p|div|address)\b[^>]*class=["'][^"']*\b(?:byline|author(?:-name)?|writer|contributor)\b[^"']*["'][^>]*>([\s\S]{0,200}?)<\//gi;

// True for strings that aren't plausible person-name bylines: URLs,
// social handles, mailto, raw email addresses. JSON-LD `author` fields
// and OpenGraph `article:author` are both commonly populated with a
// profile URL rather than a name (per spec, in OG's case), and that
// previously inflated the distinct-bylines count.
function looksLikeUrlOrHandle(s: string): boolean {
  if (/^(?:https?:|ftp:|mailto:|tel:|\/\/)/i.test(s)) return true;
  if (s.startsWith("@")) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return true;
  return false;
}

function extractMetaMap(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const head = html.slice(0, 256 * 1024);
  for (const match of head.matchAll(META_TAG_RE)) {
    const tag = match[0];
    const nameMatch = tag.match(META_NAME_RE);
    const contentMatch = tag.match(META_CONTENT_RE);
    if (!nameMatch || !contentMatch) continue;
    out.set(nameMatch[1].toLowerCase(), contentMatch[1]);
  }
  return out;
}

function detectPlatformHint(metas: Map<string, string>, html: string): PlatformHint | null {
  const generator = (metas.get("generator") ?? "").toLowerCase();
  if (generator.includes("substack")) return "substack";
  if (generator.includes("beehiiv")) return "beehiiv";
  if (generator.includes("ghost")) return "ghost";
  if (generator.includes("wordpress")) return "wordpress";
  if (generator.includes("wix")) return "wix";
  if (generator.includes("squarespace")) return "squarespace";
  // Generator meta is absent on many sites; fall back to body-level hints.
  // Beehiiv's strongest fingerprint is its CDN domain `media.beehiiv.com`,
  // which appears in og:image / twitter:image / favicon / preload tags on
  // every Beehiiv-hosted publication (cultivated.news has 117 occurrences
  // starting at byte 225). The `data-beehiiv-` attribute we previously
  // relied on is no longer emitted by current Beehiiv templates.
  const head = html.slice(0, 64 * 1024);
  if (/beehiiv\.com|data-beehiiv-/i.test(head)) return "beehiiv";
  if (/substackcdn\.com|substack\.com\/api/i.test(head)) return "substack";
  if (/\/ghost\/api\/|ghost\.io/i.test(head)) return "ghost";
  if (/wp-content\/|wp-includes\//i.test(head)) return "wordpress";
  return null;
}

function countSectionNav(html: string, rootDomain: string): {
  count: number;
  samples: string[];
} {
  const body = html.slice(0, NAV_SCAN_MAX_BYTES);
  const segCounts = new Map<string, number>();
  for (const match of body.matchAll(ANCHOR_RE)) {
    let u: URL;
    try {
      u = new URL(match[1], `https://${rootDomain}/`);
    } catch {
      continue;
    }
    if (u.hostname.replace(/^www\./, "") !== rootDomain) continue;
    const segments = u.pathname.split("/").filter(Boolean);
    // A section is a segment used as a *parent* for deeper paths
    // (e.g. /bills/some-bill/, /politics/article-slug/). Counting
    // segments at depth 1 alone would over-credit leaf article slugs
    // on sites that publish articles directly at root (`/<slug>/`),
    // including newsroom homepages that link each article twice from
    // headline + thumbnail cards. Same shape as how a non-news site
    // would build internal-linking SEO; require structural depth to
    // exclude both cases together.
    if (segments.length < 2) continue;
    const firstSeg = segments[0];
    const segLower = firstSeg.toLowerCase();
    if (segLower.length < 2) continue;
    // All-digit segments are dates (year-archive pages) or numeric IDs,
    // not editorial sections.
    if (/^\d+$/.test(segLower)) continue;
    if (NON_SECTION_PATHS.has(segLower)) continue;
    segCounts.set(segLower, (segCounts.get(segLower) ?? 0) + 1);
  }
  const sections = [...segCounts.entries()]
    .filter(([, n]) => n >= MIN_SECTION_ANCHOR_OCCURRENCES)
    .sort((a, b) => b[1] - a[1])
    .map(([seg]) => seg);
  return { count: sections.length, samples: sections.slice(0, 8) };
}

function countNewsroomLinks(html: string, rootDomain: string): {
  count: number;
  samples: string[];
} {
  const body = html.slice(0, NAV_SCAN_MAX_BYTES);
  const found = new Set<string>();
  for (const match of body.matchAll(ANCHOR_RE)) {
    let u: URL;
    try {
      u = new URL(match[1], `https://${rootDomain}/`);
    } catch {
      continue;
    }
    if (u.hostname.replace(/^www\./, "") !== rootDomain) continue;
    const path = u.pathname.toLowerCase();
    for (const candidate of NEWSROOM_LINK_PATHS) {
      if (path === candidate || path === `${candidate}/` || path.startsWith(`${candidate}/`)) {
        found.add(candidate);
      }
    }
  }
  return { count: found.size, samples: Array.from(found).slice(0, 6) };
}

function detectCommerceFingerprints(html: string): string[] {
  const out: string[] = [];
  const head = html.slice(0, 512 * 1024);
  for (const sig of COMMERCE_SIGNATURES) {
    if (sig.re.test(head)) out.push(sig.id);
  }
  return out;
}

async function fetchText(url: string): Promise<{
  status: number;
  text: string | null;
  errorMessage?: string;
  finalUrl: string;
}> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BASELINE_USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(PREFLIGHT_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { status: res.status, text: null, finalUrl: res.url };
    }
    const text = await res.text();
    return { status: res.status, text, finalUrl: res.url };
  } catch (err) {
    return {
      status: 0,
      text: null,
      errorMessage: err instanceof Error ? err.message : String(err),
      finalUrl: url,
    };
  }
}

async function fetchHomepage(
  rootDomain: string,
): Promise<{ parsed: PreflightHomepage; html: string | null }> {
  const homepageUrl = `https://${rootDomain}/`;
  const { status, text, errorMessage } = await fetchText(homepageUrl);
  if (!text) {
    return {
      parsed: {
        fetchedUrl: homepageUrl,
        status: "error",
        httpStatus: status || null,
        errorMessage: errorMessage ?? `HTTP ${status}`,
        ogSiteName: null,
        ogType: null,
        metaGenerator: null,
        sectionNavCount: 0,
        sectionNavSamples: [],
        newsroomLinkCount: 0,
        newsroomLinkSamples: [],
        commerceFingerprints: [],
      },
      html: null,
    };
  }
  const metas = extractMetaMap(text);
  const sectionNav = countSectionNav(text, rootDomain);
  const newsroomLinks = countNewsroomLinks(text, rootDomain);
  return {
    parsed: {
      fetchedUrl: homepageUrl,
      status: "ok",
      httpStatus: status,
      ogSiteName: metas.get("og:site_name") ?? null,
      ogType: metas.get("og:type") ?? null,
      metaGenerator: metas.get("generator") ?? null,
      sectionNavCount: sectionNav.count,
      sectionNavSamples: sectionNav.samples,
      newsroomLinkCount: newsroomLinks.count,
      newsroomLinkSamples: newsroomLinks.samples,
      commerceFingerprints: detectCommerceFingerprints(text),
    },
    html: text,
  };
}

type ParsedArticle = {
  jsonLdType: "NewsArticle" | "Article" | "other" | "none";
  authors: string[];
  publishedAt: string | null;
};

function parseJsonLd(html: string): {
  newsArticle: boolean;
  genericArticle: boolean;
  authors: string[];
  publishedAt: string | null;
} {
  let newsArticle = false;
  let genericArticle = false;
  const authors = new Set<string>();
  let publishedAt: string | null = null;

  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    const types = Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
    for (const ty of types) {
      if (/^(NewsArticle|ReportageNewsArticle|AnalysisNewsArticle|OpinionNewsArticle)$/i.test(ty)) {
        newsArticle = true;
      } else if (/^Article$/i.test(ty)) {
        genericArticle = true;
      }
    }
    const author = obj.author;
    const collectAuthor = (a: unknown) => {
      if (!a) return;
      if (typeof a === "string") {
        const trimmed = a.trim();
        if (trimmed && !looksLikeUrlOrHandle(trimmed)) authors.add(trimmed);
      } else if (typeof a === "object") {
        const name = (a as Record<string, unknown>).name;
        if (typeof name === "string") {
          const trimmed = name.trim();
          if (trimmed && !looksLikeUrlOrHandle(trimmed)) authors.add(trimmed);
        }
      }
    };
    if (Array.isArray(author)) for (const a of author) collectAuthor(a);
    else if (author) collectAuthor(author);

    const datePublished = obj.datePublished;
    if (typeof datePublished === "string" && !publishedAt) {
      publishedAt = datePublished;
    }

    // Recurse so nested @graph arrays (common in many CMSes) are visited.
    for (const v of Object.values(obj)) visit(v);
  };

  for (const match of html.matchAll(JSON_LD_RE)) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      visit(JSON.parse(raw));
    } catch {
      // CMS often emits invalid JSON-LD (trailing commas, unescaped
      // characters). Skip silently — a single bad block shouldn't
      // poison the rest of the signal stack.
    }
  }

  return {
    newsArticle,
    genericArticle,
    authors: Array.from(authors),
    publishedAt,
  };
}

function parseArticleMetadata(html: string): ParsedArticle {
  const metas = extractMetaMap(html);
  const jsonLd = parseJsonLd(html);
  const authors = new Set<string>(jsonLd.authors);

  // Author meta-tag tier (Parse.ly, Dublin Core, OpenGraph, plain).
  const metaAuthorKeys = [
    "author",
    "article:author",
    "parsely-author",
    "sailthru.author",
    "dc.creator",
    "dcterms.creator",
    "citation_author",
  ];
  for (const key of metaAuthorKeys) {
    const v = metas.get(key);
    if (!v) continue;
    const trimmed = v.trim();
    // article:author is specced as a profile URL on the Open Graph side,
    // and Parse.ly / other tags occasionally hold a social-profile URL
    // instead of a person name. Drop those — they pollute the
    // distinct-byline count and don't represent a real author identity.
    if (trimmed && !looksLikeUrlOrHandle(trimmed)) authors.add(trimmed);
  }

  // Class-name byline tier — last-resort visual byline detection. Names
  // are filtered to plausible person-name shape (2-4 capitalized tokens,
  // no slashes, no digits) so generic tag-cloud entries don't pollute
  // the distinct-author count.
  for (const match of html.matchAll(BYLINE_CLASS_RE)) {
    const fragment = match[1].replace(/<[^>]+>/g, " ");
    const cleaned = fragment.replace(/\s+/g, " ").trim();
    const candidate = cleaned.replace(/^by\s+/i, "");
    if (
      candidate.length >= 4 &&
      candidate.length <= 80 &&
      /^[A-Z][a-zA-Z'.-]+(\s+[A-Z][a-zA-Z'.-]+){1,3}$/.test(candidate)
    ) {
      authors.add(candidate);
    }
  }

  let publishedAt = jsonLd.publishedAt;
  if (!publishedAt) {
    const candidates = [
      metas.get("article:published_time"),
      metas.get("og:published_time"),
      metas.get("date"),
      metas.get("dc.date"),
      metas.get("citation_publication_date"),
    ];
    for (const c of candidates) {
      if (c) {
        publishedAt = c;
        break;
      }
    }
  }
  if (!publishedAt) {
    // First <time datetime="..."> in document order — the article header
    // date almost always wins this race ahead of sidebar / related-content
    // dates. If a weird template puts a related-article date first we'd
    // mis-attribute, but the failure mode is benign: we only check whether
    // the parsed date falls within the recent-cadence window.
    const m = html.match(TIME_DATETIME_RE);
    if (m && m[1]) publishedAt = m[1];
  }

  let jsonLdType: ParsedArticle["jsonLdType"] = "none";
  if (jsonLd.newsArticle) jsonLdType = "NewsArticle";
  else if (jsonLd.genericArticle) jsonLdType = "Article";

  return {
    jsonLdType,
    authors: Array.from(authors),
    publishedAt,
  };
}

async function gatherArticleSignals(
  rootDomain: string,
): Promise<PreflightArticles> {
  // Reuse L4's existing discovery, capped at a smaller sample size — L0
  // only needs to characterize, not measure. Bare-minimum politeness
  // pause between fetches; the Inngest function-level per-domain
  // throttle further spaces things out across runs.
  const sample = await findSampleArticleUrls(rootDomain);
  const urlsToFetch = sample.urls.slice(0, PREFLIGHT_ARTICLE_SAMPLE_SIZE);
  const parsed: ParsedArticle[] = [];
  for (let i = 0; i < urlsToFetch.length; i++) {
    if (i > 0) {
      await new Promise((r) =>
        setTimeout(r, 1000 / POLITENESS.perDomainRequestsPerSecond),
      );
    }
    const { text } = await fetchText(urlsToFetch[i]);
    if (!text) continue;
    parsed.push(parseArticleMetadata(text));
  }

  const distinctBylines = new Set<string>();
  let jsonLdNewsArticleCount = 0;
  let jsonLdGenericArticleCount = 0;
  let authorMetaTagHits = 0;
  let recentArticleCount = 0;
  const cutoff =
    Date.now() - RECENT_ARTICLE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  for (const a of parsed) {
    if (a.jsonLdType === "NewsArticle") jsonLdNewsArticleCount++;
    else if (a.jsonLdType === "Article") jsonLdGenericArticleCount++;
    if (a.authors.length > 0) authorMetaTagHits++;
    for (const author of a.authors) distinctBylines.add(author);
    if (a.publishedAt) {
      const ts = Date.parse(a.publishedAt);
      if (!Number.isNaN(ts) && ts >= cutoff) recentArticleCount++;
    }
  }

  return {
    source: sample.source,
    sampledUrls: urlsToFetch,
    fetchCount: parsed.length,
    jsonLdNewsArticleCount,
    jsonLdGenericArticleCount,
    distinctBylines: Array.from(distinctBylines),
    authorMetaTagHits,
    recentArticleCount,
  };
}

// Scoring tables. Centralized so the methodology page can describe them
// and so changes are visible in one diff. Positive weights = news-like;
// negative = not-news-like. Thresholds live in preflight-verdicts.ts.
function score(args: {
  rootDomain: string;
  homepage: PreflightHomepage;
  articles: PreflightArticles;
  wikipedia: WikipediaLookupResult | null;
  platform: PlatformHint | null;
}): { score: number; reasons: PreflightReason[] } {
  const reasons: PreflightReason[] = [];
  let total = 0;
  const add = (signal: string, delta: number, detail: string) => {
    if (delta === 0) return;
    total += delta;
    reasons.push({ signal, delta, detail });
  };

  // Strong positive — JSON-LD NewsArticle / Wikipedia / multi-byline.
  if (args.articles.jsonLdNewsArticleCount > 0) {
    add(
      "json_ld_news_article",
      3,
      `${args.articles.jsonLdNewsArticleCount} of ${args.articles.fetchCount} sampled articles declare schema.org NewsArticle.`,
    );
  }
  if (args.wikipedia?.status === "found" && args.wikipedia.matchedTitle) {
    add(
      "wikipedia_article",
      3,
      `Wikipedia article "${args.wikipedia.matchedTitle}" references this domain.`,
    );
  }
  if (args.articles.distinctBylines.length >= 2) {
    add(
      "distinct_bylines",
      3,
      `${args.articles.distinctBylines.length} distinct bylines across sampled articles.`,
    );
  }

  // Medium positive — recent cadence + section nav.
  if (args.articles.recentArticleCount >= 2) {
    add(
      "recent_article_cadence",
      2,
      `${args.articles.recentArticleCount} sampled articles published within ${RECENT_ARTICLE_WINDOW_DAYS} days.`,
    );
  }
  if (args.homepage.sectionNavCount >= 3) {
    add(
      "section_nav",
      2,
      `${args.homepage.sectionNavCount} topical sections in homepage nav (${args.homepage.sectionNavSamples.join(", ")}).`,
    );
  }
  if (args.homepage.newsroomLinkCount >= 2) {
    add(
      "newsroom_pages",
      2,
      `Newsroom pages present: ${args.homepage.newsroomLinkSamples.join(", ")}.`,
    );
  }

  // Weak positive — og:type=article, author meta only.
  // (We deliberately do not reward generic schema.org Article: corporate
  // blogs, recipe sites, and product pages all use it. NewsArticle gets
  // the strong +3 above; generic Article on its own carries no signal
  // in either direction.)
  if (args.homepage.ogType?.toLowerCase() === "article") {
    add("og_type_article", 1, "Homepage declares og:type=article.");
  }
  if (
    args.articles.authorMetaTagHits > 0 &&
    args.articles.distinctBylines.length < 2
  ) {
    // Award the weak signal only when the stronger distinct-bylines
    // signal didn't already fire — avoid double-counting the same
    // underlying fact.
    add(
      "author_metadata",
      1,
      `${args.articles.authorMetaTagHits} sampled articles expose author metadata.`,
    );
  }
  if (args.articles.sampledUrls.length >= 3) {
    add(
      "article_discoverability",
      1,
      `${args.articles.sampledUrls.length} article-shaped URLs found via ${args.articles.source}.`,
    );
  }

  // Counter-signals.
  if (args.homepage.ogType?.toLowerCase() === "product") {
    add("og_type_product", -3, "Homepage declares og:type=product.");
  }
  if (args.homepage.commerceFingerprints.length > 0) {
    // Softened from -4 because a real news outlet can legitimately have
    // WooCommerce / similar installed for subscriptions, merchandise, or
    // donations — and the fingerprint regex fires on plugin presence,
    // not on the homepage actually being commerce-shaped. Genuine
    // storefronts almost always also declare og:type=product on the
    // homepage (separate -3 below), so the combined penalty for true
    // commerce-first sites stays at -5.
    add(
      "commerce_fingerprint",
      -2,
      `E-commerce platform detected (${args.homepage.commerceFingerprints.join(", ")}).`,
    );
  }
  if (
    args.articles.fetchCount > 0 &&
    args.articles.distinctBylines.length === 1
  ) {
    add(
      "single_byline_only",
      -2,
      `Only one author across all sampled articles — consistent with a single-author blog.`,
    );
  }
  // Article-shaped penalties (no_author_signal, no_recent_articles)
  // only fire when we have evidence the samples actually WERE articles.
  // Sites like PBS link a mix of show pages, video pages, and topic
  // landing pages from their sitemap; when our sample of three lands
  // entirely on non-article content (no Article schema anywhere),
  // penalizing "no bylines / no recent dates" is the wrong inference —
  // we can't conclude anything about editorial cadence from a sample
  // we have no evidence is editorial.
  const sampleHasArticleMarkup =
    args.articles.jsonLdNewsArticleCount > 0 ||
    args.articles.jsonLdGenericArticleCount > 0;

  if (
    sampleHasArticleMarkup &&
    args.articles.fetchCount > 0 &&
    args.articles.distinctBylines.length === 0 &&
    args.articles.authorMetaTagHits === 0
  ) {
    add(
      "no_author_signal",
      -1,
      "No author signal on any sampled article.",
    );
  }
  if (args.rootDomain.startsWith(CORPORATE_BLOG_SUBDOMAIN_PREFIX)) {
    add(
      "corporate_blog_subdomain",
      -2,
      `Hostname starts with "${CORPORATE_BLOG_SUBDOMAIN_PREFIX}" — typical corporate-blog placement, not a primary publication.`,
    );
  }
  if (args.homepage.ogSiteName) {
    const normalized = args.homepage.ogSiteName.trim().toLowerCase();
    if (GENERIC_SITE_NAMES.has(normalized)) {
      add(
        "generic_og_site_name",
        -2,
        `og:site_name is the uncustomized default ("${args.homepage.ogSiteName}") — real publications brand this field.`,
      );
    }
  }
  if (
    sampleHasArticleMarkup &&
    args.articles.fetchCount > 0 &&
    args.articles.recentArticleCount === 0
  ) {
    add(
      "no_recent_articles",
      -1,
      `No sampled articles published within ${RECENT_ARTICLE_WINDOW_DAYS} days — publishes below typical news cadence.`,
    );
  }

  // Platform context (informational, no score delta — the override
  // happens in the verdict translator). Recorded as a reason so the
  // evidence panel surfaces why a low-score newsletter passed anyway.
  if (args.platform && NEWSLETTER_PLATFORMS.has(args.platform)) {
    reasons.push({
      signal: "newsletter_platform",
      delta: 0,
      detail: `Hosted on ${args.platform}; newsletter platforms are accepted by policy regardless of score.`,
    });
  }

  return { score: total, reasons };
}

export async function runPreflight(
  rootDomain: string,
): Promise<PreflightSignal> {
  const fetchedAt = new Date().toISOString();

  // Social-platform denylist short-circuits before any fetches. Skips
  // homepage / Wikipedia / article sampling entirely — there's no
  // analysis to do on a Reddit thread or X post that would change the
  // verdict. The translator turns this into a hard not_news.
  if (SOCIAL_PLATFORM_DENYLIST.has(rootDomain)) {
    return {
      rootDomain,
      fetchedAt,
      status: "ok",
      homepage: {
        fetchedUrl: `https://${rootDomain}/`,
        status: "ok",
        httpStatus: null,
        ogSiteName: null,
        ogType: null,
        metaGenerator: null,
        sectionNavCount: 0,
        sectionNavSamples: [],
        newsroomLinkCount: 0,
        newsroomLinkSamples: [],
        commerceFingerprints: [],
      },
      articles: {
        source: "none",
        sampledUrls: [],
        fetchCount: 0,
        jsonLdNewsArticleCount: 0,
        jsonLdGenericArticleCount: 0,
        distinctBylines: [],
        authorMetaTagHits: 0,
        recentArticleCount: 0,
      },
      wikipedia: null,
      platform: null,
      newsletterPlatformOverride: false,
      socialPlatformDenied: true,
      score: 0,
      reasons: [
        {
          signal: "social_platform",
          delta: 0,
          detail: `${rootDomain} is a social-media platform — Cited only assesses editorial publications.`,
        },
      ],
    };
  }

  const { parsed: homepage, html } = await fetchHomepage(rootDomain);

  if (homepage.status === "error") {
    // Don't fail closed. Article-sample discovery starts with
    // /sitemap.xml, which is designed for crawlers and is often
    // reachable even when the homepage is gated by an edge-level bot
    // challenge (e.g. Akamai 202 on ESPN). Wikipedia is independent of
    // the publisher's infrastructure entirely. Both are worth trying
    // in parallel before falling back on the verdict translator's
    // error-aware rule.
    const [articles, wikipedia] = await Promise.all([
      gatherArticleSignals(rootDomain),
      lookupWikipedia({ ogSiteName: null, rootDomain }),
    ]);
    const { score: total, reasons } = score({
      rootDomain,
      homepage,
      articles,
      wikipedia,
      platform: null,
    });
    return {
      rootDomain,
      fetchedAt,
      status: "error",
      errorMessage: homepage.errorMessage,
      homepage,
      articles,
      wikipedia,
      platform: null,
      newsletterPlatformOverride: false,
      socialPlatformDenied: false,
      score: total,
      reasons,
    };
  }

  const platform = html ? detectPlatformHint(extractMetaMap(html), html) : null;

  const [articles, wikipedia] = await Promise.all([
    gatherArticleSignals(rootDomain),
    lookupWikipedia({
      ogSiteName: homepage.ogSiteName,
      rootDomain,
    }),
  ]);

  const { score: total, reasons } = score({
    rootDomain,
    homepage,
    articles,
    wikipedia,
    platform,
  });

  const newsletterPlatformOverride =
    platform !== null && NEWSLETTER_PLATFORMS.has(platform);

  return {
    rootDomain,
    fetchedAt,
    status: "ok",
    homepage,
    articles,
    wikipedia,
    platform,
    newsletterPlatformOverride,
    socialPlatformDenied: false,
    score: total,
    reasons,
  };
}
