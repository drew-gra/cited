@AGENTS.md

# Cited — project guide for Claude Code

Cited is a public, no-login tool at `breadandlaw.com/cited` that assesses whether
a news outlet's content is accessible to major AI platforms — across training,
real-time retrieval, and AI-powered search. Every assessment "shows its work":
the evidence behind each verdict is persisted and exposed in the UI.

For the product brief and architecture rationale, see `README.md` and
`DESIGN.md`.

## Stack

- **Next.js 16 (App Router)** with `basePath: "/cited"` so the marketing site
  can rewrite `breadandlaw.com/cited/*` to this app.
- **React 19**, **Tailwind CSS 4** (via `@theme` in `src/app/globals.css`).
- **TypeScript strict.**
- **Neon Postgres** (provisioned via Vercel Marketplace) + **Drizzle ORM**.
- **Inngest** for the queued assessment workflow, with per-domain throttle.
- Bench tools (`scripts/probe.ts`, `scripts/batch-summary.ts`) run the
  L1 / L2 / L4 pipelines statelessly — no DB, no queue — for fast iteration on detectors.

## The seven-layer pipeline

Cited's verdict is a stack of layered heuristics. Each layer is a pure
algorithm that produces evidence; a per-layer translator turns that evidence
into a uniform `LayerVerdict` in a strict five-value vocabulary.

| Layer | What it does | TTL | Status |
|---|---|---|---|
| 1 — robots.txt | Fetch and parse `/robots.txt` against the v1 AI bot list; also detect hosting platform (Beehiiv / Substack / Ghost / WordPress / Wix). | 24h | **Live** |
| 2 — HTTP / HTML declarations | Fetch homepage, extract `X-Robots-Tag`, `meta robots`, AI-bot-specific meta tags. Probe `/llms.txt` with content-type validation. | 24h | **Live** |
| 3 — CDN / hosting fingerprint | Pure-function detector over L2's captured headers; identifies Cloudflare / CloudFront / Fastly / Akamai / Vercel / Netlify / Imperva / Sucuri. | 30d | **Live** |
| 4 — User-agent A/B probing | Discover 5 article URLs (sitemap → RSS → homepage scrape); fetch each with a baseline browser UA and with each AI bot UA, serialized at 1 req/sec per domain; compare status / size / SHA-256 hash (first 200KB). | 7d | **Live** |
| 5 — Common Crawl presence | Query CC's CDX API across the last six monthly CC-MAIN indexes; bucket coverage; compute a conservative trend with three guardrails. | 30d | **Live** |
| 6 — External dataset cross-reference | Layer 6 input (deals, lawsuits, coalitions). Schema-supported, empty. | n/a | Post-v1 |
| 7 — End-to-end product probing | Querying actual AI assistants. | n/a | Post-v1 |

## Layer verdict vocabulary

Every layer maps its raw evidence to a `LayerVerdict` (see `src/lib/verdicts.ts`):

- **permissive** — evidence points toward AI access being granted.
- **restrictive** — evidence points toward AI access being denied.
- **mixed** — signals within the layer point different directions.
- **contextual** — layer characterizes capacity/identity, not direction (e.g., L3 is always contextual).
- **inconclusive** — layer couldn't be evaluated or has insufficient data.

Translators are pure functions and computed on every API read; verdicts are
NOT persisted. If a translator changes, the next read picks up the new
classification automatically.

## Schema (Drizzle, in `src/lib/db/schema.ts`)

Seven tables:

- **outlets** — one row per root domain. `first_assessed_at` / `last_full_assessment_at`.
- **assessment_runs** — one row per user-initiated job. Per-layer status fields (`pending` / `running` / `done` / `error` / `skipped`) drive the partial-render UI.
- **assessments** — five rows per run (one per AI platform). Holds the per-platform `training_access` / `realtime_access` / `search_access` / `aggregate_posture` / `confidence`.
- **signals** — raw evidence per (outlet, layer) with per-row `ttl_seconds`. JSONB `signal_value` holds the heterogeneous evidence shape.
- **probe_log** — Layer 4 raw probe records. One row per (outlet, sample URL, UA, timestamp) with status, response size, response hash.
- **known_relationships** — Layer 6 input. Empty in v1.
- **ip_rate_limits** — backs the 20-fresh-assessments-per-IP-per-hour cap.

Initial migration is at `drizzle/0000_init.sql`. To re-generate after schema
edits: `npm run db:generate`. To apply to the dev DB: `npm run db:push`. For
production: `npm run db:migrate`.

## Request lifecycle

1. `POST /api/assess` — validates URL, finds-or-creates outlet, computes
   per-layer freshness against TTLs.
2. **Cache check** — if every implemented layer has a fresh signal and a
   prior run exists where all those layers are `done`, return that run's id
   inline. No new Inngest event.
3. **Partial-refresh path** — if some layers are stale, create a new run
   with stale-layer statuses set to `pending` and fresh-layer statuses
   pre-marked `done`. Send Inngest event with `layersToRun` listing only
   the stale ones.
4. **Inngest function `assess-outlet`** — runs only the layers in
   `layersToRun`, persists new `signals` rows for each, computes
   per-platform `assessments` from the latest L1 signal (which may be from
   a prior run). Throttled to 1 outbound request per second per target
   domain via Inngest's flow control.
5. `GET /api/assess/:id` — polled by the result page every 2s; returns
   the per-layer signal data plus computed `verdicts`. Polling stops when
   `run.status === "done"`.

## File map (key paths)

```
src/
  app/
    api/
      assess/route.ts            — POST + cache/partial-refresh gate
      assess/[id]/route.ts       — GET (polling target)
      inngest/route.ts           — Inngest serve handler (servePath set
                                   explicitly because of basePath)
    assess/[id]/page.tsx         — result page with verdict-aware layer rows
    page.tsx                     — input form
    methodology/page.tsx         — methodology page (per-layer descriptions)
    layout.tsx, globals.css      — design tokens (Satoshi / black bg / gray scale)
  lib/
    ai-platforms.ts              — v1 platforms + bot UAs
    api-types.ts                 — AssessResponse + LayerVerdict response shape
    db/
      schema.ts, index.ts        — Drizzle schema + lazy-init client
    domain.ts                    — URL normalization
    inngest/
      client.ts, functions.ts    — Inngest client + assess-outlet workflow
    layers/
      robots.ts                  — Layer 1 fetcher + parser
      platform.ts                — Layer 1 sub-detector (Beehiiv / Substack / etc.)
      declarations.ts            — Layer 2 fetcher + llms.txt validator
      cdn.ts                     — Layer 3 pure-function detector
      sitemap.ts                 — Layer 4 article-URL discovery (sitemap / RSS / homepage)
      ua-probing.ts              — Layer 4 probeUrl + comparison + summarizer
      common-crawl.ts            — Layer 5 CDX queries + trend logic
    policy.ts                    — TTLs, politeness rule, UA string
    rate-limit.ts                — IP rate limiter (Postgres-backed)
    verdicts.ts                  — LayerVerdict shape + translators
scripts/
  probe.ts                       — stateless L1/L2/L4 bench probe (--brief, --l2, --l4)
  batch-summary.ts               — stateless bulk L1 stress test
drizzle/                          — schema migrations
```

## Design system

Source of truth: `DESIGN.md` (a checked-in snapshot of the Bread & Law tokens
maintained on the user's Drive). Hard constraints:

- Single font family — **Satoshi** (Fontshare CDN), weights 200 / 400 / 500. No bold.
- Gray-scale palette pinned to hex in `@theme`: `bg-black`, `text-gray-100/400/600`, `border-gray-700`.
- Body size is **16px** everywhere; 14px requires explicit approval.
- Uppercase labels use `tracking-[0.2em]` or `tracking-[0.3em]`.
- **Prohibited without approval:** gradients, drop shadows, border-radius > 2px, icons / emoji, semantic colors (red/green/blue for meaning), multiple font families.
- Cited follows the **Tools** pattern (left-justified, wider container, no parent brand header) — not the marketing-homepage pattern.

## What's done, what's open

**Done in v1:** L0 (preflight news-outlet classification), L1, L2, L3, L4,
L5, platform detector, surgical refresh cache, LayerVerdict shape +
translators for every layer, per-layer expandable evidence panels
(including L4's per-bot verdicts + raw probe table), methodology page,
IP rate limit, basePath rewrite-friendly URL handling.

**Preflight (L0) hardening — follow-ups:**
- Newsroom-pages detector matches exact paths (`/about`, `/staff`, etc.).
  Misses common variants like `/about-us`, `/our-team`, `/who-we-are`.
  Expand or switch to substring matching with a short denylist.
- Wikipedia search is English-only (`en.wikipedia.org`). Non-English
  outlets won't get the +3 even when a matching article exists on the
  appropriate language Wikipedia. Probably defer until a real
  non-English test case appears.
- Score thresholds (≥5 / 2–4 / ≤1) are a first guess. Should be
  calibrated against a labeled corpus of known-news / known-not-news
  URLs once one exists.
- Article-sample fetches happen serially with a 1s politeness pause —
  meaningful latency on L0, which is on the critical path before the
  rest of the pipeline. Consider parallelizing the homepage + Wikipedia
  + first-article fetch (per-domain politeness still applies for
  same-host article samples).

**Pending in v1:**
- **S4b (posture rule table)** — currently per-platform postures are
  derived from L1 only. The LayerVerdict shape from S4a + L4's per-bot
  aggregates are the inputs; S4b is the rule logic that combines them into
  per-platform `training_access` / `realtime_access` / `search_access`
  and the aggregate `posture`. Posture vocabulary stays at four values
  (`open` / `mixed` / `blocked` / `unknown`); edge-blocked sites collapse
  into `blocked` with the evidence panel explaining where the block lives.
- **Deployment** — Neon and Inngest provisioned for production; Vercel
  project created; `the-thing/vercel.json` rewrite added pointing at the
  deployed Cited project. Instructions in README.

**Residual L4 limitation.** Sites behind a Cloudflare *managed challenge*
(JS-based, not just UA-keyed — e.g. mjbizdaily.com) block both the bot UA
and the baseline browser UA, because solving the challenge requires
running JS that `fetch()` doesn't. For these sites L4 reports
`baseline_failed → inconclusive`, and the L3 "Cloudflare detected"
evidence is the load-bearing finding. Headless-browser probing (Playwright
or similar) is out of scope for v1.

## Workflow

Local dev requires three terminals:

```
# Terminal A — Next dev server
npm run dev

# Terminal B — Inngest dev server (auto-discovers SDK at /cited/api/inngest)
npx inngest-cli@latest dev -u http://localhost:3000/cited/api/inngest

# Terminal C (optional) — Drizzle Studio
npm run db:studio
```

Visit `http://localhost:3000/cited` (NOT `/` — the basePath rewrites
everything under `/cited`).

For local dev the Inngest SDK runs in dev mode via `INNGEST_DEV=1` in
`.env.local` (no signing key needed).

## Tone and conventions

- **No comments unless WHY is non-obvious.** Most code doesn't need them.
- **No emoji, no icons** in code or output. Plain text only.
- **Honesty over confidence** in verdicts and headlines — `inconclusive`
  is a load-bearing finding, not a stopgap. The product distinguishes
  itself from snake-oil tools by being honest about what's knowable from
  public signals.
- **`unknown` and `inconclusive` are features.** Layered architecture
  reduces uncertainty but doesn't eliminate it; the UI must say so.
- **Per-platform granularity is sacred.** Collapsing to a single
  outlet-level verdict loses the most interesting information (deal-driven
  variance between OpenAI vs Anthropic vs Google, etc.).
