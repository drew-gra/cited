/**
 * Layer 2 — HTTP / HTML declarations.
 *
 * Fetches the root domain's homepage, extracts X-Robots-Tag headers and
 * <meta name="robots"> + AI-bot-specific meta tags from the HTML. Then
 * probes /llms.txt as a separate fetch.
 *
 * No DOM parser dependency — meta tags are extracted with regex. That's
 * fine for our purpose (we want known names with known content) and avoids
 * shipping cheerio/jsdom for a handful of regexes.
 */

import { z } from "zod";
import { POLITENESS, userAgent } from "../policy";

export const l2HomepageSchema = z.object({
  fetchedUrl: z.string(),
  status: z.enum(["ok", "error"]),
  httpStatus: z.number().nullable(),
  errorMessage: z.string().optional(),
  xRobotsTag: z.string().nullable(),
  metaRobots: z.string().nullable(),
  aiMetaTags: z.record(z.string(), z.string()),
  aiContentDeclaration: z.string().nullable(),
  responseHeaders: z.record(z.string(), z.string()),
});

export const l2LlmsTxtSchema = z.object({
  url: z.string(),
  state: z.enum(["present", "absent", "error"]),
  httpStatus: z.number().nullable(),
  sizeBytes: z.number().nullable(),
  errorMessage: z.string().optional(),
});

// Runtime schema for the persisted L2 signal. Source of truth.
export const l2ResultSchema = z.object({
  rootDomain: z.string(),
  fetchedAt: z.string(),
  homepage: l2HomepageSchema,
  llmsTxt: l2LlmsTxtSchema,
});

export type L2Homepage = z.infer<typeof l2HomepageSchema>;
export type L2LlmsTxt = z.infer<typeof l2LlmsTxtSchema>;
export type L2Result = z.infer<typeof l2ResultSchema>;

// Meta names we want to capture. "robots" and "googlebot" are conventional;
// the rest are AI-bot-specific names that some publishers use to scope
// directives like "noindex,nofollow" to specific bots.
const AI_BOT_NAMES = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "Google-Extended",
  "PerplexityBot",
  "Perplexity-User",
  "CCBot",
] as const;

const RELEVANT_META_NAMES = new Set<string>([
  "robots",
  "googlebot",
  "ai-content-declaration",
  ...AI_BOT_NAMES,
]);

// Headers we capture from the homepage response for Layer 3 use. Lowercased.
const INTERESTING_HEADERS = [
  // Content / policy
  "x-robots-tag",
  "cache-control",
  // Hosting / CDN identifying headers
  "server",
  "via",
  "powered-by",
  "x-powered-by",
  // Cloudflare
  "cf-ray",
  "cf-cache-status",
  // CloudFront / AWS
  "x-amz-cf-id",
  "x-amz-cf-pop",
  // Fastly
  "x-served-by",
  "x-fastly-request-id",
  "x-cache",
  // Fastly's x-timer debug header. Critical to capture: when a publisher
  // redirects to a canonical URL (e.g. theguardian.com → /us), the final
  // response often drops server/via/x-served-by but retains x-timer.
  // Without it we'd miss Fastly on many redirecting publishers.
  "x-timer",
  // Akamai
  "x-akamai-request-id",
  "x-akamai-transformed",
  // Vercel
  "x-vercel-id",
  "x-vercel-cache",
  // Netlify
  "x-nf-request-id",
  // Imperva / Incapsula
  "x-iinfo",
  "x-cdn",
  // Sucuri
  "x-sucuri-id",
  "x-sucuri-cache",
] as const;

const META_TAG_RE = /<meta\b[^>]*>/gi;
const META_NAME_RE = /\bname=["']([^"']+)["']/i;
const META_CONTENT_RE = /\bcontent=["']([^"']*)["']/i;

function extractRelevantMetas(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  // Cap the scan at the first ~256KB — meta tags live in <head>, so we
  // never need the full body for very large pages.
  const head = html.slice(0, 256 * 1024);
  for (const match of head.matchAll(META_TAG_RE)) {
    const tag = match[0];
    const nameMatch = tag.match(META_NAME_RE);
    const contentMatch = tag.match(META_CONTENT_RE);
    if (!nameMatch || !contentMatch) continue;
    const name = nameMatch[1];
    if (RELEVANT_META_NAMES.has(name)) {
      result[name] = contentMatch[1];
    }
  }
  return result;
}

export async function fetchL2(rootDomain: string): Promise<L2Result> {
  const fetchedAt = new Date().toISOString();
  const headers = { "User-Agent": userAgent() };
  const homepageUrl = `https://${rootDomain}/`;

  let homepage: L2Homepage;
  try {
    const res = await fetch(homepageUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(POLITENESS.fetchTimeoutMs),
    });
    const responseHeaders: Record<string, string> = {};
    for (const name of INTERESTING_HEADERS) {
      const v = res.headers.get(name);
      if (v) responseHeaders[name] = v;
    }
    if (!res.ok) {
      homepage = {
        fetchedUrl: res.url,
        status: "error",
        httpStatus: res.status,
        errorMessage: `HTTP ${res.status}`,
        xRobotsTag: responseHeaders["x-robots-tag"] ?? null,
        metaRobots: null,
        aiMetaTags: {},
        aiContentDeclaration: null,
        responseHeaders,
      };
    } else {
      const xRobotsTag = responseHeaders["x-robots-tag"] ?? null;
      const html = await res.text();
      const metas = extractRelevantMetas(html);
      const aiMetas: Record<string, string> = {};
      for (const name of AI_BOT_NAMES) {
        if (metas[name]) aiMetas[name] = metas[name];
      }
      homepage = {
        fetchedUrl: res.url,
        status: "ok",
        httpStatus: res.status,
        xRobotsTag,
        metaRobots: metas.robots ?? null,
        aiMetaTags: aiMetas,
        aiContentDeclaration: metas["ai-content-declaration"] ?? null,
        responseHeaders,
      };
    }
  } catch (err) {
    homepage = {
      fetchedUrl: homepageUrl,
      status: "error",
      httpStatus: null,
      errorMessage: err instanceof Error ? err.message : String(err),
      xRobotsTag: null,
      metaRobots: null,
      aiMetaTags: {},
      aiContentDeclaration: null,
      responseHeaders: {},
    };
  }

  const llmsUrl = `https://${rootDomain}/llms.txt`;
  let llmsTxt: L2LlmsTxt;
  try {
    const res = await fetch(llmsUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(POLITENESS.fetchTimeoutMs),
    });
    if (res.ok) {
      const text = await res.text();
      // CMS soft-404s often return 200 OK with the homepage HTML for unknown
      // paths. Validate that this is actually a text/markdown llms.txt by
      // both content-type and a content sniff (real files start with `#` per
      // the llms.txt convention).
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      const isTextual =
        contentType.startsWith("text/plain") ||
        contentType.startsWith("text/markdown");
      const looksLikeMarkdown = /^﻿?#\s/.test(text.trimStart());
      if (isTextual && looksLikeMarkdown) {
        llmsTxt = {
          url: llmsUrl,
          state: "present",
          httpStatus: res.status,
          sizeBytes: text.length,
        };
      } else {
        llmsTxt = {
          url: llmsUrl,
          state: "absent",
          httpStatus: res.status,
          sizeBytes: null,
          errorMessage: `200 but not a real llms.txt (content-type=${contentType || "unknown"})`,
        };
      }
    } else {
      llmsTxt = {
        url: llmsUrl,
        state: "absent",
        httpStatus: res.status,
        sizeBytes: null,
      };
    }
  } catch (err) {
    llmsTxt = {
      url: llmsUrl,
      state: "error",
      httpStatus: null,
      sizeBytes: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  return { rootDomain, fetchedAt, homepage, llmsTxt };
}
