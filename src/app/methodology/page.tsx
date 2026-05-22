import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Methodology — Cited",
  description: "How Cited assesses AI accessibility for news outlets.",
};

export default function MethodologyPage() {
  return (
    <main className="mx-auto flex w-full max-w-[680px] flex-col gap-12 px-6 py-16 sm:py-24">
      <header className="flex flex-col gap-4">
        <span className="font-medium uppercase tracking-[0.3em] text-gray-600">
          <a
            href="https://www.breadandlaw.com"
            target="_blank"
            rel="noreferrer noopener"
            className="hover:text-gray-100 hover:underline hover:underline-offset-4"
          >
            Bread &amp; Law
          </a>
          {" / "}
          <Link
            href="/"
            className="hover:text-gray-100 hover:underline hover:underline-offset-4"
          >
            Cited
          </Link>
        </span>
        <h1 className="text-gray-100">Methodology</h1>
        <p className="max-w-prose text-gray-400">
          Cited&apos;s assessment is a layered pipeline. Each layer surfaces a
          different kind of evidence about whether a domain&apos;s content is
          accessible to AI platforms across training, real-time retrieval, and
          AI-powered search. Layers run independently; their outputs combine
          into a per-platform posture. We show every layer&apos;s raw evidence
          so you can replicate the work yourself.
        </p>
        <p className="max-w-prose text-gray-400">
          v1 of Cited implements a preflight news-outlet check plus Layers
          1–5 in production. Layer 6 (external dataset cross-reference)
          and Layer 7 (end-to-end product probing) are out of scope for v1
          and described below.
        </p>
      </header>

      <Section
        title="Preflight — News-outlet classification"
        status="Live"
        body={[
          "Cited only assesses news outlets. Before the main pipeline runs, a preflight layer collects evidence that the submitted URL is a real editorial operation and classifies the result as news, borderline, or not-news. Not-news classifications skip Layers 1–5 entirely; borderline classifications proceed with a noisier-verdict warning.",
          "Signals stack across three sources. From the homepage we read the OpenGraph site name and type, the page generator (which often names a hosting platform), the breadth of topical sections in the nav, and counter-signals for e-commerce platforms. From a small sample of recent articles we parse JSON-LD schema.org types (NewsArticle being the strongest single signal), distinct bylines across articles, author metadata, and publish-date freshness. From Wikipedia we check whether an article exists that references this domain — a free proxy for the domain-authority signal a paid SEO tool would otherwise provide.",
          "Each signal contributes a small positive or negative weight to a transparent score. Newsletter platforms (Substack, Beehiiv, Ghost) require enough infrastructure investment that they're unlikely to host half-hearted corporate marketing, so a detected newsletter platform is treated as news regardless of score. Every contributing signal — positive or negative — is shown in the evidence panel so the verdict is auditable rather than opaque.",
        ]}
      />

      <Section
        title="Layer 1 — robots.txt"
        status="Live"
        body={[
          "We fetch /robots.txt from the root domain and parse it against each AI platform's documented user agents. A Disallow rule that matches a bot indicates the site does not want that bot to crawl the path; a missing rule or an explicit Allow indicates accessibility. The drilldown shows exact line numbers in the file so you can verify the parse.",
          "robots.txt is voluntary. A well-behaved bot honors it; a non-compliant bot may not. Layer 4 cross-checks by fetching as the bot and comparing responses.",
        ]}
      />

      <Section
        title="Layer 2 — HTTP and HTML declarations"
        status="Live"
        body={[
          "Beyond robots.txt, sites can signal preferences via the X-Robots-Tag response header, the meta robots tag (including max-snippet and noai variants), and emerging conventions like llms.txt and the IPTC dataMining field. We fetch the homepage, extract these signals, and probe /llms.txt as a separate request. The /llms.txt fetch validates content-type and structure to avoid false positives from CMS soft-404s that serve the homepage for unknown paths.",
        ]}
      />

      <Section
        title="Layer 3 — Infrastructure fingerprint"
        status="Live"
        body={[
          "Response headers from the homepage identify the CDN or WAF a site uses — Cloudflare (cf-ray), CloudFront (x-amz-cf-id), Fastly (x-served-by), Akamai (x-akamai-request-id), Vercel, Netlify, Imperva, Sucuri. Network-layer AI bot blocking — increasingly common — typically happens at the CDN, so this layer informs whether a site is likely to drop bot traffic before it reaches the origin. Layer 3 piggybacks on Layer 2's homepage fetch; no separate network request.",
        ]}
      />

      <Section
        title="Layer 4 — User-agent A/B probing"
        status="Live"
        body={[
          "We pull a small sample of recent articles from the sitemap (or, when no sitemap is available, from the RSS feed or homepage anchors), fetch each with a baseline browser user agent, then refetch as each AI bot's canonical user agent. Differential responses — different status codes, substantially different response sizes, or non-matching content hashes — indicate active blocking even when robots.txt allows the bot.",
          "We respect a one-request-per-second-per-domain politeness rule throughout this layer. This is the one layer where we deliberately do not honor the target's robots.txt: the purpose is to measure what AI bots actually experience at the server, not what the file claims.",
          "When the baseline browser user agent is also blocked at the edge, Layer 4 reports inconclusive — what's blocking is then a CDN-level rule and the Layer 3 evidence is what applies.",
        ]}
      />

      <Section
        title="Layer 5 — Common Crawl presence"
        status="Live"
        body={[
          "Common Crawl is one of the largest public web crawls and feeds many open and proprietary AI training corpora. We query the Common Crawl CDX index for the domain across the most recent six monthly CC-MAIN indexes, count records per snapshot, and report a coverage bucket (absent / low / moderate / high) plus a trend direction (decreasing / steady / increasing).",
          "Low or trending-down coverage is a leading indicator that models trained primarily on Common Crawl will not have seen the site's recent content. CC presence is permanent for past indexes — a publisher who blocks CC today still has whatever history CC captured before the block took effect. CC absence does not prove training-data absence (AI companies use many corpora), and CC presence does not prove training-data presence (companies filter what they ingest).",
        ]}
      />

      <section className="flex flex-col gap-4">
        <h2 className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Out of scope (for now)
        </h2>
        <p className="max-w-prose text-gray-400">
          Cited v1 does not yet incorporate external dataset cross-referencing
          (Layer 6 — known licensing deals, lawsuits, coalitions) or
          end-to-end product probing of AI assistants themselves (Layer 7).
          The database schema accommodates both layers; we&apos;ll layer them
          in once the foundation is stable.
        </p>
      </section>

      <footer className="flex flex-col gap-2 text-gray-600">
        <Link href="/" className="underline underline-offset-4 hover:text-gray-400">
          Back to Cited
        </Link>
        <p className="mt-4">
          Cited is available to clients as a managed service. Email enquiries
          to newbiz at breadandlaw dot com.
        </p>
        <p className="mt-8 self-center">© 2026 Bread &amp; Law LLC</p>
      </footer>
    </main>
  );
}

function Section({
  title,
  status,
  body,
}: {
  title: string;
  status: "Live" | "Coming soon";
  body: string[];
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium uppercase tracking-[0.2em] text-gray-600">
          {title}
        </h2>
        <span className="text-gray-600">{status}</span>
      </div>
      {body.map((para, i) => (
        <p key={i} className="max-w-prose text-gray-400">
          {para}
        </p>
      ))}
    </section>
  );
}
