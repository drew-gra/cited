"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

const PLATFORMS = [
  { name: "OpenAI", bots: "GPTBot, ChatGPT-User, OAI-SearchBot" },
  { name: "Anthropic", bots: "ClaudeBot, Claude-User, Claude-SearchBot" },
  { name: "Google", bots: "Google-Extended" },
  { name: "Perplexity", bots: "PerplexityBot, Perplexity-User" },
  { name: "Common Crawl", bots: "CCBot" },
];

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
          Bread &amp; Law / Tools
        </span>
        <h1 className="text-gray-100">Cited</h1>
        <p className="max-w-prose text-gray-400">
          Paste the URL of a news outlet or article. Cited assesses whether that
          domain is accessible to major AI platforms across training, real-time
          retrieval, and AI-powered search — and shows its work.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <label
          htmlFor="url"
          className="font-medium uppercase tracking-[0.2em] text-gray-600"
        >
          News outlet or article URL
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
          className="self-start border border-gray-700 px-6 py-3 font-medium uppercase tracking-[0.2em] text-gray-100 hover:border-gray-100 disabled:text-gray-600 disabled:hover:border-gray-700"
        >
          {submitting ? "Assessing…" : "Run assessment"}
        </button>
        {error ? <p className="text-gray-400">{error}</p> : null}
      </form>

      <section className="flex flex-col gap-6">
        <h2 className="font-medium uppercase tracking-[0.2em] text-gray-600">
          What gets checked
        </h2>
        <ul className="flex flex-col divide-y divide-gray-700 border-y border-gray-700">
          {PLATFORMS.map((platform) => (
            <li
              key={platform.name}
              className="flex flex-col gap-1 py-4 sm:flex-row sm:justify-between sm:gap-8"
            >
              <span className="text-gray-100">{platform.name}</span>
              <span className="text-gray-400 sm:text-right">
                {platform.bots}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="flex flex-col gap-2 text-gray-600">
        <Link
          href="/methodology"
          className="underline underline-offset-4 hover:text-gray-400"
        >
          How Cited works
        </Link>
      </footer>
    </main>
  );
}
