"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function CitedPage() {
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
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
      router.push(`/assess/${id}`);
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
          Cited is a free tool that shows whether or not a given news article
          can influence AI results, right now.{" "}
          <Link
            href="/methodology"
            className="underline underline-offset-4 hover:text-gray-100"
          >
            Technical details
          </Link>
          .
        </p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label
          htmlFor="url"
          className="font-medium uppercase tracking-[0.2em] text-gray-600"
        >
          Article URL
        </label>
        <input
          id="url"
          name="url"
          type="url"
          required
          inputMode="url"
          autoComplete="url"
          placeholder="https://www.nytimes.com/section/business"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={submitting}
          className="w-full border border-gray-700 bg-black px-4 py-3 text-gray-100 placeholder:text-gray-600 focus:border-gray-100 focus:outline-none disabled:text-gray-600"
        />
        <button
          type="submit"
          disabled={submitting || !url}
          className="self-start font-medium uppercase tracking-[0.2em] text-gray-100 hover:underline hover:underline-offset-4 disabled:cursor-default disabled:text-gray-600 disabled:no-underline"
        >
          {submitting ? "Assessing…" : "Run assessment"}
        </button>
        {error ? <p className="text-gray-400">{error}</p> : null}
      </form>

      <section className="flex flex-col gap-6">
        <h2 className="font-medium uppercase tracking-[0.2em] text-gray-600">
          What gets checked
        </h2>
        <p className="text-gray-100">
          Anthropic | OpenAI | Perplexity | Google | Common Crawl
        </p>
      </section>

      <footer className="flex flex-col gap-2 text-gray-600">
        <p className="self-center">© 2026 Bread &amp; Law LLC</p>
      </footer>
    </main>
  );
}
