"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PreflightDot } from "@/components/PreflightDot";
import { LicensingModal } from "@/components/LicensingModal";
import type { PreflightFinding } from "@/lib/preflight-verdicts";

// L0-aware submit: after POST returns a run id, poll until preflight has
// produced a verdict. On news/borderline, navigate to the result page.
// On not_news, stay on this form, light up the red dot, and retain the
// URL the user typed so they can edit and retry.
const PREFLIGHT_POLL_INTERVAL_MS = 1000;

export default function CitedPage() {
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRunId, setPendingRunId] = useState<string | null>(null);
  const [lastFinding, setLastFinding] = useState<PreflightFinding | null>(null);
  const [licensingOpen, setLicensingOpen] = useState(false);
  const router = useRouter();

  // Poll the pending run until preflight resolves, then either route or
  // settle in place. The dot stays gray throughout the poll (lastFinding
  // is null) and only flips to a color when we have a definitive answer.
  useEffect(() => {
    if (!pendingRunId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll(id: string) {
      try {
        const res = await fetch(`/cited/api/assess/${id}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`Failed to load run (${res.status}).`);
        const data = (await res.json()) as {
          run: { preflight: { status: string } };
          preflightVerdict: { finding: PreflightFinding };
        };
        if (cancelled) return;
        if (data.run.preflight.status === "done") {
          const finding = data.preflightVerdict.finding;
          if (finding === "not_news") {
            setLastFinding("not_news");
            setSubmitting(false);
            setPendingRunId(null);
          } else {
            router.push(`/assess/${id}`);
          }
          return;
        }
        timer = setTimeout(() => poll(id), PREFLIGHT_POLL_INTERVAL_MS);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unknown error.");
        setSubmitting(false);
        setPendingRunId(null);
      }
    }
    poll(pendingRunId);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pendingRunId, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    setLastFinding(null);
    try {
      const res = await fetch("/cited/api/assess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Assessment request failed (${res.status}).`,
        );
      }
      const { id } = (await res.json()) as { id: string };
      setPendingRunId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error.");
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-[680px] flex-col gap-16 px-6 py-16 sm:py-24">
      <header className="flex flex-col gap-6">
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
          Cited analyzes news for discoverability across different AI
          platforms by observing in real time how AI models interact with
          the content of news publishers. It is one of Bread &amp; Law&apos;s
          proprietary tools.
        </p>
        <p className="text-gray-400">
          <Link
            href="/methodology"
            className="underline underline-offset-4 hover:text-gray-100"
          >
            Technical Details
          </Link>
          {" | "}
          <button
            type="button"
            onClick={() => setLicensingOpen(true)}
            className="cursor-pointer underline underline-offset-4 hover:text-gray-100"
          >
            Licensing
          </button>
        </p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label
          htmlFor="url"
          className="font-medium uppercase tracking-[0.2em] text-gray-600"
        >
          Coverage to analyze
        </label>
        <input
          id="url"
          name="url"
          type="url"
          required
          inputMode="url"
          autoComplete="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            // Any keystroke resets the dot — the previous attempt's
            // verdict no longer describes what the user is about to do.
            if (lastFinding !== null) setLastFinding(null);
          }}
          disabled={submitting}
          className="w-full border border-gray-700 bg-black px-4 py-3 text-gray-100 placeholder:text-gray-600 focus:border-gray-100 focus:outline-none disabled:text-gray-600"
        />
        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={submitting || !url}
            className="font-medium uppercase tracking-[0.2em] text-gray-100 hover:underline hover:underline-offset-4 disabled:cursor-default disabled:text-gray-600 disabled:no-underline"
          >
            {submitting ? "Assessing…" : "Run assessment"}
          </button>
          <PreflightDot finding={lastFinding} />
        </div>
        {error ? <p className="text-gray-400">{error}</p> : null}
      </form>

      <p className="text-gray-600">
        <span className="font-medium uppercase tracking-[0.2em]">
          What&apos;s checked:
        </span>{" "}
        Anthropic | OpenAI | Perplexity | Google | Common Crawl
      </p>

      <footer className="flex flex-col gap-2 text-gray-600">
        <p className="self-center">© 2026 Bread &amp; Law LLC</p>
      </footer>

      <LicensingModal
        open={licensingOpen}
        onClose={() => setLicensingOpen(false)}
      />
    </main>
  );
}
