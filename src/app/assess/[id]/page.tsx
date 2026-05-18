"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  AssessResponse,
  LayerNumber,
  PlatformAssessment,
} from "@/lib/api-types";
import { FINDING_LABEL, type LayerVerdict } from "@/lib/verdicts";
import { LAYER_PLAIN_DESCRIPTION } from "@/lib/layer-descriptions";
import { formatLayerMarkdown } from "@/lib/copy-details";
import {
  BOTS,
  PLATFORMS,
  PLATFORM_LABELS,
  type AiPlatform,
  type BotPurpose,
} from "@/lib/ai-platforms";

const POLL_INTERVAL_MS = 2000;

const LAYER_LABEL: Record<LayerNumber, string> = {
  1: "Layer 1 — robots.txt",
  2: "Layer 2 — HTTP / HTML declarations",
  3: "Layer 3 — Infrastructure fingerprint",
  4: "Layer 4 — User-agent A/B probing",
  5: "Layer 5 — Common Crawl presence",
};

function accessDotColor(
  access: PlatformAssessment["trainingAccess"] | null,
): string {
  switch (access) {
    case "allowed":
      return "#4ade80";
    case "blocked":
      return "#f87171";
    case "unknown":
      return "#fbbf24";
    default:
      return "#4b5563";
  }
}

function purposeAccess(
  a: PlatformAssessment | undefined,
  purpose: BotPurpose,
): PlatformAssessment["trainingAccess"] | null {
  if (!a) return null;
  if (purpose === "training") return a.trainingAccess;
  if (purpose === "realtime") return a.realtimeAccess;
  return a.searchAccess;
}

function purposeHasBot(
  platform: AiPlatform,
  purpose: BotPurpose,
): boolean {
  return BOTS.some((b) => b.platform === platform && b.purpose === purpose);
}

function layerStatusLabel(
  snap: AssessResponse["run"]["layers"][LayerNumber],
): string | null {
  if (snap.status === "skipped") return "Coming soon";
  if (snap.status === "running") return "Running…";
  if (snap.status === "error") return "Error";
  if (snap.status === "pending") return "Pending";
  return null;
}

export default function ResultPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [data, setData] = useState<AssessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openHelpLayer, setOpenHelpLayer] = useState<LayerNumber | null>(null);
  const [copiedLayer, setCopiedLayer] = useState<LayerNumber | null>(null);
  const [inputUrl, setInputUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (openHelpLayer === null) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenHelpLayer(null);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [openHelpLayer]);

  useEffect(() => {
    setSubmitting(false);
    setSubmitError(null);
    setInputUrl("");
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const res = await fetch(`/cited/api/assess/${id}`, { cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
          } | null;
          throw new Error(
            body?.error ?? `Failed to load assessment (${res.status}).`,
          );
        }
        const result = (await res.json()) as AssessResponse;
        if (cancelled) return;
        setData(result);
        setError(null);
        if (
          result.run.status === "pending" ||
          result.run.status === "running"
        ) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unknown error.");
      }
    }
    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/cited/api/assess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: inputUrl }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Assessment request failed (${res.status}).`,
        );
      }
      const { id: newId } = (await res.json()) as { id: string };
      if (newId === id) {
        setSubmitting(false);
        setInputUrl("");
        return;
      }
      router.push(`/assess/${newId}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Unknown error.");
      setSubmitting(false);
    }
  }

  async function handleCopyDetails(layer: LayerNumber) {
    if (!data) return;
    const md = formatLayerMarkdown(layer, data);
    if (!md) return;
    try {
      await navigator.clipboard.writeText(md);
      setCopiedLayer(layer);
      setTimeout(() => {
        setCopiedLayer((c) => (c === layer ? null : c));
      }, 1500);
    } catch {
      // clipboard unavailable; silent
    }
  }

  async function handleRefresh() {
    if (!data) return;
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch("/cited/api/assess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: data.outlet.primaryUrl,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Refresh failed.");
      }
      const { id: newId } = (await res.json()) as { id: string };
      if (newId === id) {
        setRefreshing(false);
        return;
      }
      router.push(`/assess/${newId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed.");
      setRefreshing(false);
    }
  }

  if (error && !data) {
    return (
      <main className="mx-auto flex w-full max-w-[920px] flex-col gap-8 px-6 py-16">
        <p className="text-gray-400">{error}</p>
        <Link
          href="/"
          className="text-gray-100 underline underline-offset-4 hover:text-gray-400"
        >
          Back
        </Link>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto flex w-full max-w-[920px] flex-col gap-8 px-6 py-16">
        <p className="text-gray-400">Loading…</p>
      </main>
    );
  }

  const isRunning =
    data.run.status === "pending" || data.run.status === "running";
  const anyLayerStale = Object.values(data.run.layers).some(
    (snap) => snap.status === "done" && snap.isStale,
  );

  return (
    <main className="mx-auto flex w-full max-w-[920px] flex-col gap-12 px-6 py-16 sm:py-24">
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
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          disabled={submitting}
          className="w-full border border-gray-700 bg-black px-4 py-3 text-gray-100 placeholder:text-gray-600 focus:border-gray-100 focus:outline-none disabled:text-gray-600"
        />
        <button
          type="submit"
          disabled={submitting || !inputUrl}
          className="self-start font-medium uppercase tracking-[0.2em] text-gray-100 hover:underline hover:underline-offset-4 disabled:cursor-default disabled:text-gray-600 disabled:no-underline"
        >
          {submitting ? "Assessing…" : "Run assessment"}
        </button>
        {submitError ? (
          <p className="text-gray-400">{submitError}</p>
        ) : null}
      </form>

      <p className="text-gray-400">
        <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Current Assessment:
        </span>{" "}
        <a
          href={data.outlet.primaryUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-4 hover:text-gray-100"
        >
          {data.outlet.rootDomain}
        </a>
      </p>

      {error ? (
        <p className="border border-gray-700 p-4 text-gray-400">{error}</p>
      ) : null}

      <section className="flex flex-col gap-8">
        <ul className="grid grid-cols-5 gap-2">
          {PLATFORMS.map((platform) => {
            const a = data.assessments.find((x) => x.platform === platform);
            const purposes = (
              ["training", "realtime", "search"] as const
            ).filter((p) => purposeHasBot(platform, p));
            return (
              <li key={platform} className="flex">
                <div className="flex w-full flex-col items-center gap-6 py-4 text-center">
                  <span className="flex gap-1.5">
                    {purposes.map((purpose) => {
                      const access = purposeAccess(a, purpose);
                      return (
                        <span
                          key={purpose}
                          aria-label={`${purpose}: ${access ?? "pending"}`}
                          style={{ backgroundColor: accessDotColor(access) }}
                          className="block h-3 w-3 rounded-full"
                        />
                      );
                    })}
                  </span>
                  <span className="text-sm uppercase tracking-[0.15em] text-gray-400">
                    {PLATFORM_LABELS[platform]}
                  </span>
                  <span className="text-sm text-gray-600">
                    {purposes.join(" · ")}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="text-gray-400">
        <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Data State:
        </span>{" "}
        {isRunning || refreshing
          ? "Cited is working. It can take several minutes to crawl with politeness…"
          : anyLayerStale
            ? "This outlet's data may not be up to date."
            : "This outlet's data is up to date."}
        {!isRunning && !refreshing ? (
          <>
            {" "}
            <button
              type="button"
              onClick={handleRefresh}
              className="underline underline-offset-4 hover:text-gray-100"
            >
              Refresh
            </button>
          </>
        ) : null}
      </p>

      <section className="flex flex-col gap-4">
        <h2 className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Technical Analysis
        </h2>
        <ul className="flex flex-col divide-y divide-gray-700 border-y border-gray-700">
          {([1, 2, 3, 4, 5] as const).map((layer) => {
            const snap = data.run.layers[layer];
            const verdict: LayerVerdict | undefined = data.verdicts.find(
              (v) => v.layer === layer,
            );
            const hasEvidence =
              (layer === 1 && data.layer1Signal !== null) ||
              (layer === 2 && data.layer2Signal !== null) ||
              (layer === 3 && data.layer3Signal !== null) ||
              (layer === 4 && data.layer4Signal !== null) ||
              (layer === 5 && data.layer5Signal !== null);
            const statusLabel = layerStatusLabel(snap);
            const wasCopied = copiedLayer === layer;
            return (
              <li key={layer} className="flex flex-col gap-2 py-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8">
                  <span className="inline-flex items-baseline gap-2">
                    <span className="text-gray-100">
                      {LAYER_LABEL[layer]}
                    </span>
                    <button
                      type="button"
                      onClick={() => setOpenHelpLayer(layer)}
                      aria-label={`What does ${LAYER_LABEL[layer]} look at?`}
                      className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-gray-600 text-xs leading-none text-gray-600 hover:border-gray-100 hover:text-gray-100"
                    >
                      ?
                    </button>
                  </span>
                  {hasEvidence ? (
                    <button
                      type="button"
                      onClick={() => handleCopyDetails(layer)}
                      className="self-start text-sm font-medium uppercase tracking-[0.2em] text-gray-100 hover:underline hover:underline-offset-4 sm:self-auto"
                    >
                      {wasCopied ? "Copied" : "Copy details"}
                    </button>
                  ) : statusLabel ? (
                    <span className="text-gray-600 sm:text-right">
                      {statusLabel}
                    </span>
                  ) : null}
                </div>
                {verdict ? (
                  <p className="max-w-prose text-gray-400">
                    <span className="font-medium uppercase tracking-[0.2em] text-gray-100">
                      {FINDING_LABEL[verdict.finding]}
                    </span>
                    {" — "}
                    {verdict.headline}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {openHelpLayer !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setOpenHelpLayer(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex max-w-md flex-col gap-4 border border-gray-700 bg-black p-8"
          >
            <h3 className="font-medium uppercase tracking-[0.2em] text-gray-600">
              {LAYER_LABEL[openHelpLayer]}
            </h3>
            <p className="text-gray-100">
              {LAYER_PLAIN_DESCRIPTION[openHelpLayer]}
            </p>
            <button
              type="button"
              onClick={() => setOpenHelpLayer(null)}
              className="self-start text-sm uppercase tracking-[0.2em] text-gray-600 hover:text-gray-100"
            >
              Close
            </button>
          </div>
        </div>
      ) : null}

      <footer className="flex flex-col gap-2 text-gray-600">
        <Link
          href="/methodology"
          className="underline underline-offset-4 hover:text-gray-400"
        >
          How Cited works
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
