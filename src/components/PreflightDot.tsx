import type { PreflightFinding } from "@/lib/preflight-verdicts";

const COLOR_BY_FINDING: Record<PreflightFinding, string> = {
  news: "#4ade80",
  borderline: "#fbbf24",
  not_news: "#f87171",
};

const LABEL_BY_FINDING: Record<PreflightFinding, string> = {
  news: "News-outlet check: confirmed",
  borderline: "News-outlet check: borderline",
  not_news: "News-outlet check: not a news outlet",
};

export function PreflightDot({ finding }: { finding: PreflightFinding | null }) {
  const color = finding ? COLOR_BY_FINDING[finding] : "#4b5563";
  const label = finding
    ? LABEL_BY_FINDING[finding]
    : "News-outlet check: pending";
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      style={{ backgroundColor: color }}
      className="block h-3 w-3 rounded-full"
    />
  );
}
