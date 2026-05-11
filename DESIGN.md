# Cited — Design tokens

Mirror of the Bread & Law design system as it applies to this tool. Source of truth lives in the user's Drive doc; this is a checked-in snapshot so the code can be reviewed against it without round-tripping.

## Hard rules
- Check this spec before any visual decision.
- If a value isn't specified here, ask before assuming.
- If you find a conflict between this spec and code, stop and report.
- When auditing for compliance, list every deviation explicitly.

## Typography
- **Font:** Satoshi (Fontshare CDN). Loaded in `src/app/globals.css` via `@import`. Default Tailwind fonts (Inter, system-ui, Geist) are non-compliant.
- **Weights:** 200 extralight (display, headlines, large numbers), 400 regular (body), 500 medium (emphasis, labels). Bold 700+ is **prohibited**.
- **Sizes:** 16px (`text-base`) for all body / form / nav text. 36px (`text-4xl`) is reserved for the marketing-site brand mark — Cited does not use it. 14px (`text-sm`) requires explicit approval and is currently unused.
- **Letter spacing:** uppercase labels use `tracking-[0.2em]` or `tracking-[0.3em]`. Body text gets no added tracking.
- **Line height:** 1.6 default (set on body).

## Colors (Tailwind gray scale, pinned to hex in `@theme`)
- Background: `#000000` (black).
- Text primary: `#f3f4f6` (gray-100) — headlines, main content.
- Text secondary: `#9ca3af` (gray-400) — supporting text.
- Text muted: `#4b5563` (gray-600) — labels, footer, de-emphasized.
- Borders: `#374151` (gray-700).
- Hover: shift one step brighter in the hierarchy.
- Links: same color as surrounding text; differentiated via underline.

## Spacing
- 8px grid. Common values: 8, 16, 24, 32, 48, 64.

## Prohibited (without explicit approval)
- Gradients
- Drop shadows
- Border-radius > 2px (Cited uses square corners throughout)
- Icons or emoji
- Semantic colors (red/green/blue for meaning) — assessment posture is communicated via text + monochrome typography, not color
- Multiple font families
- Bold weight (700+)

## Cited follows the "Tools" pattern
Per the deviation rules in the parent spec, tool pages differ from the marketing homepage. Cited inherits:
- No parent "BREAD & LAW" header.
- Left-justified text.
- Wider container (`max-w-[680px]`) sized for functional content rather than the homepage's 448px.

## Open question (from parent spec, deferred)
Shareable assessment outputs (PNG cards, share images) will need a standardized branding treatment when we get there. Parent spec has a TODO; revisit before Cited ships any share-out feature.
