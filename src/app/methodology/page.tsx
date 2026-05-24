import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Methodology — Cited",
  description:
    "What Cited is and how it assesses AI accessibility for news outlets.",
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
        <p className="max-w-prose text-gray-400">
          Cited is a free analytical tool that provides a robust technical
          assessment of the accessibility of earned media content to top AI
          platforms.
        </p>
        <p className="max-w-prose text-gray-400">
          &ldquo;Can this news article influence AI results, right
          now?&rdquo; is the core question that it answers. It does this by
          assessing available data and by running simulations that create
          new signals.
        </p>
        <p className="max-w-prose text-gray-400">
          AI visibility is always important to earned media practitioners,
          in that it informs both the preparation and the analysis of the
          work. But it is difficult to assess, given the complicated and
          litigious relationship between news publishers and AI platforms.
        </p>
        <p className="max-w-prose text-gray-400">
          The tool does not itself use AI to make determinations. That is
          algorithmic. There is not one iota of AI inside this product, and
          one consequence of that is that it is uncertain far more often
          than it is wrong.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Methodology
        </h2>
        <p className="max-w-prose text-gray-400">
          Cited&apos;s assessment is a layered pipeline. Each layer surfaces
          a different kind of evidence about whether a domain&apos;s content
          is accessible to AI platforms across training, real-time
          retrieval, and AI-powered search. Layers run independently and
          combine into a per-platform posture. Technical details for each
          layer are made available via copy-paste.
        </p>
        <p className="max-w-prose text-gray-400">
          Five common AI platforms are currently used and adding more is
          conducive to scale.
        </p>
      </section>

      <Section
        title="Layer 0 — News classification"
        body={[
          "Cited is an earned-media tool and, thus, will only assess news outlets. Before the main pipeline runs, a preflight layer collects evidence that the submitted URL is a real editorial operation and classifies the result as news, borderline, or not-news.",
          "If a submitted URL fails at this layer, then it is not assessed. If it is borderline, it is assessed with that caveat.",
          "If L0 confirms the submitted URL is real news, then it runs the assessment and provides the results. Cited may be the only publicly available tool that contains a schema designed to determine whether or not a given URL is or is not news.",
        ]}
      />

      <Section
        title="Layer 1 — robots.txt"
        body={[
          "Cited fetches /robots.txt from the root domain and parses it against each AI platform's documented user agents. A publisher's instructions to AI platforms tend to live inside this file, but compliance is voluntary because enforcement is generally difficult and expensive.",
          "While many commercial AI products currently obey these instructions, not all of them do. Making a determination from /robots.txt only is cheap and easy, but it is rarely correct.",
        ]}
      />

      <Section
        title="Layer 2 — HTTP and HTML declarations"
        body={[
          "Beyond robots.txt, sites can signal preferences in other ways. Those details are assessed and analyzed at this layer.",
        ]}
      />

      <Section
        title="Layer 3 — Infrastructure fingerprint"
        body={[
          "Some parts of a publisher's technical stack provide one-click controls to disallow AI access at the network level. This layer is important because it can prove the publisher in question has the technical capacity to block AI platforms if it wants to.",
        ]}
      />

      <Section
        title="Layer 4 — User-agent A/B probing"
        body={[
          "This is the most resource-intensive part of the analysis. At L4, Cited pulls a sample of recent articles from the sitemap, fetches each with a baseline browser user agent, then refetches as each AI bot's canonical user agent.",
          "This process can prove a publisher is not serving AI platforms the same content as other traffic, indicating active blocking despite the instructions that might be in /robots.txt. When L3 detects network-level blocking, L4 returns inconclusive, which pushes the confidence of the assessment downward because there is no simulation for Cited to observe.",
        ]}
      />

      <Section
        title="Layer 5 — Common Crawl presence"
        body={[
          "Common Crawl is one of the largest public web crawls and feeds many open and proprietary AI training corpora. Cited queries the Common Crawl CDX index for the domain and reports a training intensity and a trend direction.",
          "This layer determines details behind how the URL in question can be used and has been used to train AI platforms.",
        ]}
      />

      <footer className="flex flex-col gap-2 text-gray-600">
        <p className="self-center">© 2026 Bread &amp; Law LLC</p>
      </footer>
    </main>
  );
}

function Section({
  title,
  body,
}: {
  title: string;
  body: string[];
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-medium uppercase tracking-[0.2em] text-gray-600">
        {title}
      </h2>
      {body.map((para, i) => (
        <p key={i} className="max-w-prose text-gray-400">
          {para}
        </p>
      ))}
    </section>
  );
}
