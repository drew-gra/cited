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
      return "AI bots for this platform are not blocked across the layers we tested.";
    case "blocked":
      return "AI bots for this platform are blocked or restricted somewhere in the stack.";
    case "mixed":
      return "Some bots for this platform are allowed; others are blocked or restricted.";
    case "unknown":
      return "Not enough evidence across the layers to determine posture.";
  }
}

const CONFIDENCE_LABEL: Record<PlatformAssessment["confidenceBand"], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

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
  const [openLayer, setOpenLayer] = useState<LayerNumber | null>(null);
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
                      <span className="text-gray-600">
                        Confidence: {CONFIDENCE_LABEL[a.confidenceBand]}
                      </span>
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
            const isOpen = openLayer === layer;
            const verdict: LayerVerdict | undefined = data.verdicts.find(
              (v) => v.layer === layer,
            );
            const hasEvidence =
              (layer === 1 && data.layer1Signal !== null) ||
              (layer === 2 && data.layer2Signal !== null) ||
              (layer === 3 && data.layer3Signal !== null) ||
              (layer === 4 && data.layer4Signal !== null) ||
              (layer === 5 && data.layer5Signal !== null);
            return (
              <li key={layer} className="flex flex-col">
                <button
                  type="button"
                  onClick={() => setOpenLayer(isOpen ? null : layer)}
                  disabled={!hasEvidence}
                  className="flex flex-col gap-2 py-4 text-left disabled:cursor-default"
                >
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8">
                    <span className="text-gray-100">
                      {LAYER_LABEL[layer]}
                    </span>
                    <span className="text-gray-600 sm:text-right">
                      {layerStatusLabel(snap)}
                    </span>
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
                </button>
                {isOpen && layer === 1 && data.layer1Signal ? (
                  <Layer1Evidence signal={data.layer1Signal} />
                ) : null}
                {isOpen && layer === 2 && data.layer2Signal ? (
                  <Layer2Evidence signal={data.layer2Signal} />
                ) : null}
                {isOpen && layer === 3 && data.layer3Signal ? (
                  <Layer3Evidence signal={data.layer3Signal} />
                ) : null}
                {isOpen && layer === 4 && data.layer4Signal ? (
                  <Layer4Evidence signal={data.layer4Signal} />
                ) : null}
                {isOpen && layer === 5 && data.layer5Signal ? (
                  <Layer5Evidence signal={data.layer5Signal} />
                ) : null}
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

function Layer1Evidence({
  signal,
}: {
  signal: NonNullable<AssessResponse["layer1Signal"]>;
}) {
  return (
    <div className="flex flex-col gap-4 border-t border-gray-700 py-6">
      {signal.platform.platform !== "unknown" ? (
        <div className="flex flex-col gap-2">
          <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
            Hosting platform detected
          </span>
          <span className="text-gray-100">
            {signal.platform.platform}
            {signal.platform.isDefault ? " (platform default)" : ""}
          </span>
          <p className="text-gray-400">{signal.platform.note}</p>
        </div>
      ) : null}
      {signal.sitemaps.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
            Sitemaps declared
          </span>
          <span className="text-gray-400">
            {signal.sitemaps.length} sitemap
            {signal.sitemaps.length === 1 ? "" : "s"}
          </span>
        </div>
      ) : null}
      {signal.status === "ok" && signal.rawText ? (
        <div className="flex flex-col gap-2">
          <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
            robots.txt source
          </span>
          <pre className="overflow-x-auto whitespace-pre-wrap border border-gray-700 p-4 text-gray-400">
            {signal.rawText}
          </pre>
        </div>
      ) : signal.status === "not_found" ? (
        <p className="text-gray-400">
          No /robots.txt at this domain (404). Bots are allowed by convention.
        </p>
      ) : signal.status === "error" ? (
        <p className="text-gray-400">
          Could not fetch /robots.txt: {signal.errorMessage ?? "unknown error"}
        </p>
      ) : null}
    </div>
  );
}

function Layer2Evidence({
  signal,
}: {
  signal: NonNullable<AssessResponse["layer2Signal"]>;
}) {
  const aiMetaEntries = Object.entries(signal.homepage.aiMetaTags);
  return (
    <div className="flex flex-col gap-4 border-t border-gray-700 py-6">
      {signal.homepage.status === "error" ? (
        <p className="text-gray-400">
          Could not fetch homepage:{" "}
          {signal.homepage.errorMessage ?? "unknown error"}.
          {signal.homepage.httpStatus
            ? ` HTTP ${signal.homepage.httpStatus}.`
            : ""}{" "}
          The site may be blocking generic crawlers at the CDN; Layer 4 will
          probe further when it ships.
        </p>
      ) : (
        <>
          <Row
            label="X-Robots-Tag header"
            value={signal.homepage.xRobotsTag ?? "—"}
          />
          <Row
            label="meta robots"
            value={signal.homepage.metaRobots ?? "—"}
          />
          {aiMetaEntries.length > 0 ? (
            <div className="flex flex-col gap-2">
              <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
                AI bot meta tags
              </span>
              <ul className="flex flex-col gap-1 text-gray-100">
                {aiMetaEntries.map(([name, value]) => (
                  <li key={name}>
                    <span className="text-gray-400">{name}: </span>
                    {value}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Row label="AI bot meta tags" value="—" />
          )}
          {signal.homepage.aiContentDeclaration ? (
            <Row
              label="ai-content-declaration"
              value={signal.homepage.aiContentDeclaration}
            />
          ) : null}
        </>
      )}
      <div className="flex flex-col gap-2">
        <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
          /llms.txt
        </span>
        <span className="text-gray-400">
          {signal.llmsTxt.state === "present"
            ? `present (${signal.llmsTxt.sizeBytes} bytes) — the publisher exposes a Markdown-formatted summary file intended for LLMs.`
            : signal.llmsTxt.state === "error"
              ? `error fetching: ${signal.llmsTxt.errorMessage ?? "unknown"}`
              : `absent (HTTP ${signal.llmsTxt.httpStatus ?? "?"})`}
        </span>
      </div>
    </div>
  );
}

function Layer3Evidence({
  signal,
}: {
  signal: NonNullable<AssessResponse["layer3Signal"]>;
}) {
  return (
    <div className="flex flex-col gap-4 border-t border-gray-700 py-6">
      <div className="flex flex-col gap-2">
        <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
          CDN / hosting detected
        </span>
        <span className="text-gray-100">
          {signal.detected.length > 0 ? signal.detected.join(", ") : "—"}
        </span>
        {signal.detected.length === 0 ? (
          <p className="text-gray-400">
            No known CDN signatures matched. The site may be origin-served, or
            using a CDN we don&apos;t yet fingerprint.
          </p>
        ) : null}
      </div>
      {signal.evidence.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
            Evidence
          </span>
          <ul className="flex flex-col divide-y divide-gray-700 border-y border-gray-700">
            {signal.evidence.map((e, i) => (
              <li
                key={i}
                className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8"
              >
                <span className="text-gray-100">{e.reason}</span>
                <span className="text-gray-400 sm:text-right">
                  {e.header}: {e.value}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Layer4Evidence({
  signal,
}: {
  signal: NonNullable<AssessResponse["layer4Signal"]>;
}) {
  const sourceLabel: Record<typeof signal.sampleSource, string> = {
    sitemap: "Sitemap",
    rss: "RSS / Atom feed",
    homepage: "Homepage scrape",
    none: "—",
  };
  const aggregateLabel: Record<
    (typeof signal.perBot)[number]["aggregate"],
    string
  > = {
    allowed: "Allowed",
    blocked: "Blocked",
    mixed: "Mixed",
    unknown: "Unknown",
  };

  if (signal.status === "no_urls") {
    return (
      <div className="flex flex-col gap-4 border-t border-gray-700 py-6">
        <p className="text-gray-400">
          Could not discover any article URLs to probe. We tried /sitemap.xml,
          common alternates, RSS, and homepage scraping.
        </p>
      </div>
    );
  }

  if (signal.status === "baseline_failed") {
    return (
      <div className="flex flex-col gap-4 border-t border-gray-700 py-6">
        <p className="text-gray-400">
          The baseline browser user agent was also blocked or unreachable on
          every sampled URL, so we can&apos;t tell whether AI bots are being
          treated differently. The Layer 3 (CDN / WAF) evidence is what
          applies here.
        </p>
        {signal.sampleUrls.length > 0 ? (
          <div className="flex flex-col gap-2">
            <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
              URLs attempted
            </span>
            <ul className="flex flex-col gap-1 text-gray-400">
              {signal.sampleUrls.map((u) => (
                <li key={u} className="break-all">
                  {u}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 border-t border-gray-700 py-6">
      <div className="flex flex-col gap-2">
        <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Sample source
        </span>
        <span className="text-gray-100">
          {sourceLabel[signal.sampleSource]}
          {signal.sampleSourceUrl ? ` — ${signal.sampleSourceUrl}` : ""}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Per-bot verdict
        </span>
        <ul className="flex flex-col divide-y divide-gray-700 border-y border-gray-700">
          {signal.perBot.map((bot) => (
            <li
              key={bot.ua}
              className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8"
            >
              <span className="text-gray-100">{bot.ua}</span>
              <span className="text-gray-400 sm:text-right">
                {aggregateLabel[bot.aggregate]}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
          URLs probed
        </span>
        <ul className="flex flex-col divide-y divide-gray-700 border-y border-gray-700">
          {signal.sampleUrls.map((url) => {
            const baseline = signal.probes.find(
              (p) => p.isBaseline && p.url === url,
            );
            const bots = signal.probes.filter(
              (p) => !p.isBaseline && p.url === url,
            );
            return (
              <li key={url} className="flex flex-col gap-2 py-3">
                <span className="break-all text-gray-100">{url}</span>
                <div className="flex flex-col gap-1 text-gray-400">
                  <span>
                    <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
                      baseline
                    </span>{" "}
                    {baseline?.statusCode ?? "error"}
                    {baseline?.responseSizeBytes !== undefined &&
                    baseline?.responseSizeBytes !== null
                      ? ` · ${baseline.responseSizeBytes}B`
                      : ""}
                  </span>
                  {bots.map((b) => (
                    <span key={b.userAgent}>
                      <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
                        {b.userAgent}
                      </span>{" "}
                      {b.statusCode ?? "error"}
                      {b.responseSizeBytes !== undefined &&
                      b.responseSizeBytes !== null
                        ? ` · ${b.responseSizeBytes}B`
                        : ""}
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function Layer5Evidence({
  signal,
}: {
  signal: NonNullable<AssessResponse["layer5Signal"]>;
}) {
  if (signal.indexesQueried === 0) {
    return (
      <div className="flex flex-col gap-4 border-t border-gray-700 py-6">
        <p className="text-gray-400">
          Could not fetch Common Crawl index metadata. The CDX API may be
          down or rate-limiting; try refreshing.
        </p>
      </div>
    );
  }

  const coverageLabel: Record<typeof signal.coverageBucket, string> = {
    absent: "Absent",
    low: "Low",
    moderate: "Moderate",
    high: "High",
  };
  const trendLabel: Record<typeof signal.trend, string> = {
    absent: "Not present in any queried index",
    decreasing: "Decreasing — appears less in recent indexes",
    steady: "Steady across the sampled window",
    increasing: "Increasing — appears more in recent indexes",
    insufficient_data: "Insufficient data to determine trend",
  };
  const anyCapped = signal.indexes.some((i) => i.capped);

  return (
    <div className="flex flex-col gap-4 border-t border-gray-700 py-6">
      <div className="flex flex-col gap-2">
        <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Coverage
        </span>
        <span className="text-gray-100">
          {coverageLabel[signal.coverageBucket]} —{" "}
          {signal.indexesPresent}/{signal.indexesQueried} indexes contain
          records · {signal.totalRecords}
          {anyCapped ? "+" : ""} records total
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Trend
        </span>
        <span className="text-gray-400">{trendLabel[signal.trend]}</span>
      </div>
      <div className="flex flex-col gap-2">
        <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
          Per-index breakdown
        </span>
        <ul className="flex flex-col divide-y divide-gray-700 border-y border-gray-700">
          {signal.indexes.map((idx) => (
            <li
              key={idx.indexName}
              className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8"
            >
              <span className="text-gray-100">{idx.indexName}</span>
              <span className="text-gray-400 sm:text-right">
                {idx.error
                  ? `error: ${idx.error}`
                  : `${idx.records}${idx.capped ? "+" : ""} record${
                      idx.records === 1 ? "" : "s"
                    }`}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8">
      <span className="font-medium uppercase tracking-[0.2em] text-gray-600">
        {label}
      </span>
      <span className="text-gray-400 sm:text-right">{value}</span>
    </div>
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
