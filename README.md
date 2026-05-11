# Cited

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

`GET /api/assess/:id` returns the run's status, per-layer freshness, the five per-platform assessments, and the raw Layer 1 signal so the result page can render the drilldown.

The result page (`/assess/:id`) is a client component that polls every 2s while the run is `pending` or `running`, then renders top-line + drilldown.

## v1 scope (slice 0 = Layer 1 only)

| Layer | Status | What it does |
|---|---|---|
| 1 — robots.txt | **Live** | Fetch and parse `/robots.txt` against the v1 AI bot list, surface per-bot allow/disallow with matched rule and line number. |
| 2 — HTTP / HTML declarations | Pending | `X-Robots-Tag`, `<meta name="robots">`, `llms.txt`, IPTC `dataMining`. |
| 3 — Infrastructure fingerprint | Pending | CDN/WAF detection from response headers. |
| 4 — User-agent A/B probing | Pending | Sample 3–5 articles from sitemap, probe each with the AI bot UAs, diff responses. |
| 5 — Common Crawl presence | Pending | Query the CDX index across the last 6 monthly snapshots. |

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

Outbound fetches identify as `AICitabilityBot/1.0 (+https://breadandlaw.com/cited)`. The Inngest function is throttled to one outbound request per second per target domain. Layer 4 will additionally honor any `Crawl-delay` directive in the target's robots.txt.

## Design

`DESIGN.md` is the canonical design system snapshot for this project. Source of truth lives in the user's Drive doc; the snapshot is checked in so PRs can be reviewed against it.

## What's deferred

- **Posture aggregation rule table** — slice 0 uses a placeholder rule (open if all known, blocked if all blocked, mixed if split). The full rule table lands with S4.
- **Confidence scoring** — slice 0 hard-codes 30 (one layer ran, no agreement check possible). Real scoring lands with S4.
- **Common Crawl coverage threshold** — TBD, lands with S2.
- **Anthropic `Claude-SearchBot` UA** — name needs verification against Anthropic's published docs before Layer 4 ships.
- **Sample-URL selection heuristic for Layer 4** — 2 most-recent articles + N-2 random, with sitemap → sitemap-index → RSS → homepage-extraction fallback.
- **Non-news input handling** — accepted in v1, no gatekeeping. A "this isn't a news outlet" classifier (curated list + Wikidata `instance of: news organization` + warning) lands post-v1.
- **`ai-content-declaration` parsing** — Layer 2 will parse against the IPTC `dataMining` field as the most-cited convention.
- **Methodology copy** — drafted in `/methodology`, awaiting your edits.
