"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  AssessResponse,
  LayerNumber,
  PlatformAssessment,
} from "@/lib/api-types";
import {
  PLATFORMS,
  PLATFORM_LABELS,
  type AiPlatform,
} from "@/lib/ai-platforms";

const POLL_INTERVAL_MS = 2000;

const POSTURE_LABEL: Record<PlatformAssessment["aggregatePosture"], string> = {
  open: "Open",
  mixed: "Mixed",
  blocked: "Blocked",
  unknown: "Unknown",
};

const ACCESS_LABEL: Record<PlatformAssessment["trainingAccess"], string> = {
  allowed: "Allowed",
  blocked: "Blocked",
  unknown: "Unknown",
};

const LAYER_LABEL: Record<LayerNumber, string> = {
  1: "Layer 1 — robots.txt",
  2: "Layer 2 — HTTP / HTML declarations",
  3: "Layer 3 — Infrastructure fingerprint",
  4: "Layer 4 — User-agent A/B probing",
  5: "Layer 5 — Common Crawl presence",
};

function postureSentence(
  posture: PlatformAssessment["aggregatePosture"],
): string {
  switch (posture) {
    case "open":
      return "Bots for this platform are not blocked at the robots.txt layer.";
    case "blocked":
      return "Bots for this platform are explicitly disallowed at the robots.txt layer.";
    case "mixed":
      return "Some bots for this platform are allowed; others are blocked.";
    case "unknown":
      return "Insufficient data to determine posture.";
  }
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function layerStatusLabel(snap: AssessResponse["run"]["layers"][LayerNumber]) {
  if (snap.status === "skipped") return "Coming soon";
  if (snap.status === "done")
    return `Last checked ${relativeTime(snap.capturedAt)}${snap.isStale ? " · stale" : ""}`;
  if (snap.status === "running") return "Running…";
  if (snap.status === "error") return "Error";
  return "Pending";
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
  const [openPlatform, setOpenPlatform] = useState<AiPlatform | null>(null);
  const router = useRouter();

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
          forceRefresh: true,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? "Refresh failed.");
      }
      const { id: newId } = (await res.json()) as { id: string };
      router.push(`/assess/${newId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed.");
      setRefreshing(false);
    }
  }

  if (error && !data) {
    return (
      <main className="mx-auto flex w-full max-w-[680px] flex-col gap-8 px-6 py-16">
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
      <main className="mx-auto flex w-full max-w-[680px] flex-col gap-8 px-6 py-16">
        <p className="text-gray-400">Loading…</p>
      </main>
    );
  }

  const isRunning =
    data.run.status === "pending" || data.run.status === "running";

  return (
    <main className="mx-auto flex w-full max-w-[680px] flex-col gap-12 px-6 py-16 sm:py-24">
      <header className="flex flex-col gap-4">
        <span className="font-medium uppercase tracking-[0.3em] text-gray-600">
          Bread &amp; Law / Tools / Cited
        </span>
        <h1 className="text-gray-100">{data.outlet.rootDomain}</h1>
        <a
          href={data.outlet.primaryUrl}
          className="text-gray-400 underline underline-offset-4 hover:text-gray-100"
          target="_blank"
          rel="noreferrer noopener"
        >
          {data.outlet.primaryUrl}
        </a>
      </header>

      {error ? (
        <p className="border border-gray-700 p-4 text-gray-400">{error}</p>
      ) : null}

      <section className="flex flex-col gap-4">
        <h2 className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Top-line
        </h2>
        <ul className="flex flex-col divide-y divide-gray-700 border-y border-gray-700">
          {PLATFORMS.map((platform) => {
            const a = data.assessments.find((x) => x.platform === platform);
            const isOpen = openPlatform === platform;
            return (
              <li key={platform} className="flex flex-col">
                <button
                  type="button"
                  onClick={() => setOpenPlatform(isOpen ? null : platform)}
                  className="flex flex-col gap-2 py-4 text-left sm:flex-row sm:items-baseline sm:justify-between sm:gap-8"
                >
                  <span className="text-gray-100">
                    {PLATFORM_LABELS[platform]}
                  </span>
                  {a ? (
                    <span className="flex flex-col gap-1 text-gray-400 sm:items-end">
                      <span className="font-medium uppercase tracking-[0.2em] text-gray-100">
                        {POSTURE_LABEL[a.aggregatePosture]}
                      </span>
                      <span>{postureSentence(a.aggregatePosture)}</span>
                    </span>
                  ) : (
                    <span className="text-gray-600">Pending</span>
                  )}
                </button>
                {isOpen && a ? (
                  <PlatformDrilldown
                    platform={platform}
                    assessment={a}
                    signal={data.layer1Signal}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Layers
        </h2>
        <ul className="flex flex-col divide-y divide-gray-700 border-y border-gray-700">
          {([1, 2, 3, 4, 5] as const).map((layer) => {
            const snap = data.run.layers[layer];
            return (
              <li
                key={layer}
                className="flex flex-col gap-1 py-4 sm:flex-row sm:justify-between sm:gap-8"
              >
                <span className="text-gray-100">{LAYER_LABEL[layer]}</span>
                <span className="text-gray-400 sm:text-right">
                  {layerStatusLabel(snap)}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-gray-600">
            Run {data.id.slice(0, 8)} · {isRunning ? "in progress" : "done"} ·
            updated {relativeTime(data.run.updatedAt)}
          </span>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || isRunning}
            className="self-start border border-gray-700 px-4 py-2 font-medium uppercase tracking-[0.2em] text-gray-100 hover:border-gray-100 disabled:text-gray-600 disabled:hover:border-gray-700"
          >
            {refreshing ? "Refreshing…" : "Refresh assessment"}
          </button>
        </div>
      </section>

      <footer className="flex flex-col gap-2 text-gray-600">
        <Link
          href="/methodology"
          className="underline underline-offset-4 hover:text-gray-400"
        >
          How Cited works
        </Link>
        <Link href="/" className="underline underline-offset-4 hover:text-gray-400">
          Assess another outlet
        </Link>
      </footer>
    </main>
  );
}

function PlatformDrilldown({
  platform,
  assessment,
  signal,
}: {
  platform: AiPlatform;
  assessment: PlatformAssessment;
  signal: AssessResponse["layer1Signal"];
}) {
  const platformBots =
    signal?.perBot.filter((b) => b.platform === platform) ?? [];

  return (
    <div className="flex flex-col gap-6 border-t border-gray-700 py-6">
      <div className="flex flex-col gap-3">
        <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Per-purpose access
        </span>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(["training", "realtime", "search"] as const).map((purpose) => {
            const value =
              purpose === "training"
                ? assessment.trainingAccess
                : purpose === "realtime"
                  ? assessment.realtimeAccess
                  : assessment.searchAccess;
            return (
              <div key={purpose} className="flex flex-col gap-1">
                <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
                  {purpose}
                </span>
                <span className="text-gray-100">{ACCESS_LABEL[value]}</span>
              </div>
            );
          })}
        </div>
      </div>

      {platformBots.length > 0 ? (
        <div className="flex flex-col gap-3">
          <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
            Bot-by-bot (Layer 1)
          </span>
          <ul className="flex flex-col divide-y divide-gray-700 border-y border-gray-700">
            {platformBots.map((bot) => (
              <li
                key={bot.ua}
                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8"
              >
                <span className="text-gray-100">{bot.ua}</span>
                <span className="text-gray-400 sm:text-right">
                  {ACCESS_LABEL[bot.rootAccess]}
                  {bot.matchedRule
                    ? ` · line ${bot.matchedLineNumber}: ${bot.matchedRule}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {signal?.status === "ok" && signal.rawText ? (
        <div className="flex flex-col gap-3">
          <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
            robots.txt source
          </span>
          <pre className="overflow-x-auto whitespace-pre-wrap border border-gray-700 p-4 text-gray-400">
            {signal.rawText}
          </pre>
        </div>
      ) : signal?.status === "not_found" ? (
        <p className="text-gray-400">
          No /robots.txt at this domain (404). Bots are allowed by convention.
        </p>
      ) : signal?.status === "error" ? (
        <p className="text-gray-400">
          Could not fetch /robots.txt: {signal.errorMessage}
        </p>
      ) : null}
    </div>
  );
}
