# Cited

> Source is public for transparency about Cited's methodology.
> (c) 2026 Bread & Law, LLC. All rights reserved.
> Contact newbiz at breadandlaw dot com with business or licensing inquiries.

Public per-AI-platform accessibility checker for news outlets, by Bread & Law. Lives at **breadandlaw.com/cited** in production.

A user pastes a news outlet or article URL. Cited assesses whether that domain is accessible to OpenAI / Anthropic / Google / Perplexity / Common Crawl across training, real-time retrieval, and AI-powered search — and shows its work for every layer.

## Stack

- Next.js 16 (App Router) / React 19 / Tailwind CSS 4 / TypeScript strict
- Neon Postgres (provisioned via Vercel Marketplace) + Drizzle ORM
- Inngest for the queued, throttled assessment workflow
- Vercel for hosting (Pro account)

## Architecture

`POST /api/assess` validates and normalizes the input URL, finds-or-creates the outlet row, checks whether each layer's signal is still within TTL, and either:

- returns the most recent run's id inline (cache hit), or
- creates an `assessment_runs` row, dispatches an Inngest `cited/assess.requested` event, and returns the new run id.

Inngest's `assessOutlet` function runs each layer as a `step.run`, persisting raw evidence into `signals` (with TTL) and per-platform results into `assessments`. A throttle keyed on `event.data.rootDomain` enforces the politeness rule of one outbound request per second per target domain.

`GET /api/assess/:id` returns the run's status, per-layer freshness, the five per-platform assessments (with `confidenceBand` derived on read), the raw per-layer signals, and the per-layer verdicts (also computed on read) so the result page can render the drilldown.

The result page (`/assess/:id`) is a client component that polls every 2s while the run is `pending` or `running`, then renders top-line + drilldown.

## v1 layers

| Layer | Status | What it does |
|---|---|---|
| 1 — robots.txt | **Live** | Fetch and parse `/robots.txt` against the v1 AI bot list; surface per-bot allow/disallow with matched rule and line number. Also detects hosting platform (Beehiiv / Substack / Ghost / WordPress / Wix). |
| 2 — HTTP / HTML declarations | **Live** | `X-Robots-Tag`, `<meta name="robots">`, AI-bot-specific meta tags, and `/llms.txt` with content-type validation. |
| 3 — Infrastructure fingerprint | **Live** | CDN / WAF detection from response headers; identifies Cloudflare / CloudFront / Fastly / Akamai / Vercel / Netlify / Imperva / Sucuri. Derives from L2's captured headers — no extra fetch. |
| 4 — User-agent A/B probing | **Live** | Discover 5 article URLs (sitemap → RSS → homepage scrape), fetch each with a baseline browser UA and with each AI bot UA at 1 req/sec/domain, compare status / size / SHA-256 hash of the first 200KB. |
| 5 — Common Crawl presence | **Live** | Query the CDX index across the last six monthly CC-MAIN snapshots; bucket coverage and compute a guard-railed trend. |

Each layer's raw evidence runs through a per-layer translator that produces a uniform `LayerVerdict` (`permissive` / `restrictive` / `mixed` / `contextual` / `inconclusive`). The S4b posture rule combines those verdicts into per-platform `training_access` / `realtime_access` / `search_access` / `aggregate_posture` plus a confidence integer (0–100) with a derived band (low / medium / high). Server reality (L4) overrides publisher claim (L1) on disagreement; L3 and L5 affect confidence only.

Layers 6 (external dataset cross-reference) and 7 (end-to-end product probing) are post-v1; the schema accommodates them now (`known_relationships` table is empty in v1).

## Schema

Tables (`drizzle/0000_init.sql`):

- `outlets` — one row per root domain.
- `assessment_runs` — one row per user-initiated assessment job; tracks per-layer status and run identity.
- `assessments` — one row per (outlet, platform, run); holds the per-platform result.
- `signals` — raw layer evidence with TTL; layer-keyed for surgical refresh.
- `probe_log` — Layer 4 raw probe data (one row per UA fetch).
- `known_relationships` — Layer 6 input; empty in v1.
- `ip_rate_limits` — backs the 20-fresh-assessments-per-IP-per-hour cap.

`assessment_runs`, the `assessment_run_id` foreign key on `assessments`, and `ip_rate_limits` are deviations from the original brief — added to make the queue+poll UI tractable and to back the spec's anti-abuse requirement.

## TTLs

| Layer | TTL |
|---|---|
| 1 (robots.txt) | 24 h |
| 2 (HTTP/HTML decls) | 24 h |
| 3 (CDN) | 30 d |
| 4 (UA probes) | 7 d |
| 5 (Common Crawl) | 30 d |

When a layer is stale we refresh just that layer; the user can also force a full re-run via the **Refresh assessment** button.

## Local development

### One-time setup

1. Provision a Neon database via the Vercel Marketplace and copy the **pooled** connection string.
2. Sign up for [Inngest](https://app.inngest.com), create a "Cited" project, and copy `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY`.
3. `cp .env.example .env.local` and fill in the values.
4. Apply the migration: `npm run db:push` (slice 0) or `npm run db:migrate` (production).

### Run

```bash
npm run dev                     # Next dev server on http://localhost:3000/cited
npx inngest-cli@latest dev      # Inngest dev server (separate terminal)
```

The app uses `basePath: /cited` so that `breadandlaw.com/cited/*` rewrites cleanly. In dev that means visiting `http://localhost:3000/cited`, not `/`.

### Useful scripts

```bash
npm run build         # Production build (also catches type errors)
npm run db:generate   # Regenerate the SQL migration after editing schema
npm run db:push       # Push schema directly (dev / preview)
npm run db:migrate    # Apply migrations (production)
npm run db:studio     # Drizzle Studio
```

## Deployment

1. Create a new Vercel project pointed at this repo.
2. Connect the Neon integration in the Vercel project (gives you `DATABASE_URL`).
3. Add the Inngest integration (gives you `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY`).
4. Set `CITED_USER_AGENT="AICitabilityBot/1.0 (+https://breadandlaw.com/cited)"`.
5. Run the migration against the production DB: `DATABASE_URL=<prod> npm run db:migrate`.
6. Deploy.

### Marketing site rewrite

Add to `the-thing/vercel.json` (replace `<cited-deployment-url>` with the production deployment URL of this project):

```json
{
  "rewrites": [
    {
      "source": "/cited",
      "destination": "https://<cited-deployment-url>/cited"
    },
    {
      "source": "/cited/:path*",
      "destination": "https://<cited-deployment-url>/cited/:path*"
    }
  ]
}
```

This sends `breadandlaw.com/cited/*` to this app while leaving the rest of the marketing site untouched.

## Politeness

Outbound fetches identify in two ways. Layers 1, 2, 3, and 5 use `AICitabilityBot/1.0 (+https://breadandlaw.com/cited)` as an honest crawler identifier. Layer 4 uses a baseline browser UA for sitemap / article-URL discovery (so WAFs keyed on bot-string patterns don't false-negative discovery before the comparison phase runs) and then fetches each sample URL once with that baseline browser UA and once with each of the canonical AI bot UAs (`GPTBot`, `ChatGPT-User`, `OAI-SearchBot`, `ClaudeBot`, `Claude-User`, `Claude-SearchBot`, `Google-Extended`, `PerplexityBot`, `Perplexity-User`, `CCBot`) to measure what those bots actually experience.

All fetches to the same target domain are serialized at one request per second. The Inngest function uses a `rootDomain`-keyed throttle to space invocations; Layer 4 additionally uses `step.sleep("1s")` between fetches within an invocation, since throttling cannot enforce intra-invocation politeness.

Layer 4 is the one layer where we deliberately do not honor the target's robots.txt: its purpose is to measure whether the publisher's stated policy matches the server's actual behavior, which requires fetching as the bot UAs would, including ones disallowed in robots.txt.

## Design

`DESIGN.md` is the canonical design system snapshot for this project. Source of truth lives in the user's Drive doc; the snapshot is checked in so PRs can be reviewed against it.

## What's deferred

- **Layer 6 — External dataset cross-reference.** Schema-supported (`known_relationships` table), empty in v1. Will pull from licensing-deal trackers, lawsuit filings, AI-publisher coalitions.
- **Layer 7 — End-to-end product probing.** Querying actual AI assistants for verifiable answers about the outlet. Post-v1.
- **JS-challenge handling.** Sites behind a Cloudflare *managed challenge* (JS-based, not just UA-keyed — e.g. mjbizdaily.com) block both the bot UA and the baseline browser UA, because solving the challenge requires running JS that `fetch()` doesn't. For those L4 reports `inconclusive` and L3's CDN evidence carries the load. The S4b posture rule has an explicit edge-block path that maps this evidence pattern to `blocked` rather than `unknown`. Headless-browser probing (Playwright or similar) to actually solve the challenges is post-v1.
- **Per-platform confidence granularity.** S4b's confidence is currently computed site-wide (bot-level agreement counts across all bots). Refining to per-platform agreement counts is post-v1.
- **Anthropic `Claude-SearchBot` UA.** Name still needs verification against Anthropic's published docs.
- **Non-news input handling.** Accepted today without gatekeeping. A "this isn't a news outlet" classifier (curated list + Wikidata `instance of: news organization` + warning) is post-v1.
