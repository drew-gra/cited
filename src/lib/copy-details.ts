import type { AssessResponse, LayerNumber } from "./api-types";
import type { LayerVerdict } from "./verdicts";

const LAYER_NAME: Record<LayerNumber, string> = {
  1: "Layer 1 — robots.txt",
  2: "Layer 2 — HTTP / HTML declarations",
  3: "Layer 3 — Infrastructure fingerprint",
  4: "Layer 4 — User-agent A/B probing",
  5: "Layer 5 — Common Crawl presence",
};

function header(
  layer: LayerNumber,
  data: AssessResponse,
  verdict: LayerVerdict | undefined,
): string {
  const snap = data.run.layers[layer];
  const lines = [
    `# ${LAYER_NAME[layer]}`,
    "",
    `- **Outlet:** ${data.outlet.rootDomain}`,
    `- **Captured:** ${snap.capturedAt ?? "—"}`,
    `- **Run ID:** ${data.id}`,
  ];
  if (verdict) {
    lines.push(
      `- **Verdict:** ${verdict.finding.toUpperCase()} — ${verdict.headline}`,
    );
  }
  lines.push("", "---", "");
  return lines.join("\n");
}

function accessLabel(state: "allowed" | "blocked" | "unknown"): string {
  if (state === "allowed") return "Allowed";
  if (state === "blocked") return "Blocked";
  return "Unknown";
}

function formatLayer1(data: AssessResponse): string {
  const sig = data.layer1Signal;
  if (!sig) return "";
  const verdict = data.verdicts.find((v) => v.layer === 1);
  let body = header(1, data, verdict);
  body += `**Status:** ${sig.status}\n\n`;
  if (sig.platform.platform !== "unknown") {
    body += `**Hosting platform:** ${sig.platform.platform}${
      sig.platform.isDefault ? " (platform default)" : ""
    }\n\n`;
    if (sig.platform.note) body += `${sig.platform.note}\n\n`;
  }
  if (sig.sitemaps.length > 0) {
    body += `**Sitemaps declared:** ${sig.sitemaps.length}\n\n`;
  }
  if (sig.perBot.length > 0) {
    body += `## Per-bot access\n\n`;
    for (const bot of sig.perBot) {
      const rule = bot.matchedRule
        ? ` (line ${bot.matchedLineNumber}: \`${bot.matchedRule}\`)`
        : "";
      body += `- **${bot.ua}** — ${accessLabel(bot.rootAccess)}${rule}\n`;
    }
    body += "\n";
  }
  if (sig.status === "ok" && sig.rawText) {
    body += `## Raw robots.txt\n\n\`\`\`\n${sig.rawText}\n\`\`\`\n`;
  } else if (sig.status === "not_found") {
    body += `No /robots.txt at this domain (404). Bots are allowed by convention.\n`;
  } else if (sig.status === "error") {
    body += `Could not fetch /robots.txt: ${sig.errorMessage ?? "unknown error"}\n`;
  }
  return body;
}

function formatLayer2(data: AssessResponse): string {
  const sig = data.layer2Signal;
  if (!sig) return "";
  const verdict = data.verdicts.find((v) => v.layer === 2);
  let body = header(2, data, verdict);
  if (sig.homepage.status === "error") {
    body += `## Homepage\n\nCould not fetch homepage: ${
      sig.homepage.errorMessage ?? "unknown error"
    }.`;
    if (sig.homepage.httpStatus)
      body += ` HTTP ${sig.homepage.httpStatus}.`;
    body += `\n\n`;
  } else {
    body += `## Homepage declarations\n\n`;
    body += `- **X-Robots-Tag header:** ${sig.homepage.xRobotsTag ?? "—"}\n`;
    body += `- **meta robots:** ${sig.homepage.metaRobots ?? "—"}\n`;
    const aiMeta = Object.entries(sig.homepage.aiMetaTags);
    if (aiMeta.length > 0) {
      body += `- **AI bot meta tags:**\n`;
      for (const [name, value] of aiMeta) {
        body += `  - ${name}: ${value}\n`;
      }
    } else {
      body += `- **AI bot meta tags:** —\n`;
    }
    if (sig.homepage.aiContentDeclaration) {
      body += `- **ai-content-declaration:** ${sig.homepage.aiContentDeclaration}\n`;
    }
    body += `\n`;
  }
  body += `## /llms.txt\n\n`;
  if (sig.llmsTxt.state === "present") {
    body += `Present (${sig.llmsTxt.sizeBytes} bytes) — the publisher exposes a Markdown-formatted summary file intended for LLMs.\n`;
  } else if (sig.llmsTxt.state === "error") {
    body += `Error fetching: ${sig.llmsTxt.errorMessage ?? "unknown"}\n`;
  } else {
    body += `Absent (HTTP ${sig.llmsTxt.httpStatus ?? "?"})\n`;
  }
  return body;
}

function formatLayer3(data: AssessResponse): string {
  const sig = data.layer3Signal;
  if (!sig) return "";
  const verdict = data.verdicts.find((v) => v.layer === 3);
  let body = header(3, data, verdict);
  body += `## CDN / hosting detected\n\n`;
  if (sig.detected.length > 0) {
    body += `${sig.detected.join(", ")}\n\n`;
  } else {
    body += `—\n\nNo known CDN signatures matched. The site may be origin-served, or using a CDN we don't yet fingerprint.\n\n`;
  }
  if (sig.evidence.length > 0) {
    body += `## Evidence\n\n`;
    for (const e of sig.evidence) {
      body += `- ${e.reason} — \`${e.header}: ${e.value}\`\n`;
    }
    body += `\n`;
  }
  return body;
}

function describeProbe(p: {
  statusCode: number | null;
  responseSizeBytes: number | null;
  errorKind: string | null;
  durationMs: number;
}): string {
  if (p.statusCode !== null) {
    const sizeStr =
      p.responseSizeBytes != null ? ` · ${p.responseSizeBytes}B` : "";
    return `${p.statusCode}${sizeStr}`;
  }
  if (p.errorKind === "timeout") return `timeout · ${p.durationMs}ms`;
  if (p.errorKind === "connection") return "connection error";
  return "error";
}

function formatLayer4(data: AssessResponse): string {
  const sig = data.layer4Signal;
  if (!sig) return "";
  const verdict = data.verdicts.find((v) => v.layer === 4);
  let body = header(4, data, verdict);
  body += `**Status:** ${sig.status}\n\n`;
  if (sig.status === "no_urls") {
    body += `Could not discover any article URLs to probe. Tried /sitemap.xml, common alternates, RSS, and homepage scraping.\n`;
    return body;
  }
  if (sig.sampleSourceUrl) {
    body += `**Sample source:** ${sig.sampleSource} — ${sig.sampleSourceUrl}\n\n`;
  } else {
    body += `**Sample source:** ${sig.sampleSource}\n\n`;
  }
  if (sig.status === "baseline_failed") {
    body += `The baseline browser user agent was also blocked or unreachable on every sampled URL.\n\n`;
    if (sig.sampleUrls.length > 0) {
      body += `## URLs attempted\n\n`;
      for (const u of sig.sampleUrls) body += `- ${u}\n`;
      body += `\n`;
    }
    return body;
  }
  if (sig.perBot.length > 0) {
    body += `## Per-bot verdict\n\n`;
    for (const bot of sig.perBot) {
      const agg =
        bot.aggregate === "allowed"
          ? "Allowed"
          : bot.aggregate === "blocked"
            ? "Blocked"
            : bot.aggregate === "mixed"
              ? "Mixed"
              : "Unknown";
      body += `- **${bot.ua}** — ${agg}\n`;
    }
    body += `\n`;
  }
  if (sig.sampleUrls.length > 0) {
    body += `## URLs probed\n\n`;
    for (const url of sig.sampleUrls) {
      body += `### ${url}\n\n`;
      const baseline = sig.probes.find(
        (p) => p.isBaseline && p.url === url,
      );
      const bots = sig.probes.filter(
        (p) => !p.isBaseline && p.url === url,
      );
      body += `- baseline: ${baseline ? describeProbe(baseline) : "—"}\n`;
      for (const b of bots) {
        body += `- ${b.userAgent}: ${describeProbe(b)}\n`;
      }
      body += `\n`;
    }
  }
  return body;
}

function formatLayer5(data: AssessResponse): string {
  const sig = data.layer5Signal;
  if (!sig) return "";
  const verdict = data.verdicts.find((v) => v.layer === 5);
  let body = header(5, data, verdict);
  if (sig.indexesQueried === 0) {
    body += `Could not fetch Common Crawl index metadata. The CDX API may be down or rate-limiting.\n`;
    return body;
  }
  const coverageLabel: Record<typeof sig.coverageBucket, string> = {
    absent: "Absent",
    low: "Low",
    moderate: "Moderate",
    high: "High",
  };
  const trendLabel: Record<typeof sig.trend, string> = {
    absent: "Not present in any queried index",
    decreasing: "Decreasing — appears less in recent indexes",
    steady: "Steady across the sampled window",
    increasing: "Increasing — appears more in recent indexes",
    insufficient_data: "Insufficient data to determine trend",
  };
  const anyCapped = sig.indexes.some((i) => i.capped);
  body += `## Coverage\n\n${coverageLabel[sig.coverageBucket]} — ${
    sig.indexesPresent
  }/${sig.indexesQueried} indexes contain records · ${sig.totalRecords}${
    anyCapped ? "+" : ""
  } records total\n\n`;
  body += `## Trend\n\n${trendLabel[sig.trend]}\n\n`;
  body += `## Per-index breakdown\n\n`;
  for (const idx of sig.indexes) {
    if (idx.error) {
      body += `- **${idx.indexName}** — error: ${idx.error}\n`;
    } else {
      body += `- **${idx.indexName}** — ${idx.records}${
        idx.capped ? "+" : ""
      } record${idx.records === 1 ? "" : "s"}\n`;
    }
  }
  return body;
}

export function formatLayerMarkdown(
  layer: LayerNumber,
  data: AssessResponse,
): string | null {
  switch (layer) {
    case 1:
      return data.layer1Signal ? formatLayer1(data) : null;
    case 2:
      return data.layer2Signal ? formatLayer2(data) : null;
    case 3:
      return data.layer3Signal ? formatLayer3(data) : null;
    case 4:
      return data.layer4Signal ? formatLayer4(data) : null;
    case 5:
      return data.layer5Signal ? formatLayer5(data) : null;
  }
}
