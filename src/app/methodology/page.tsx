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
          Bread &amp; Law / Tools / Cited
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
          v1 of Cited implements Layer 1 in production. Layers 2–5 are next on
          the build list. Their methodology is described below as a contract:
          this is what they will do when they ship.
        </p>
      </header>

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
        status="Coming soon"
        body={[
          "We pull a small sample of recent articles from the sitemap, fetch each with a baseline browser user agent, then refetch as each AI bot's canonical user agent. Differential responses (different status codes, different sizes, different content hashes) indicate active blocking even when robots.txt allows the bot.",
          "We respect a one-request-per-second-per-domain politeness rule throughout this layer.",
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
