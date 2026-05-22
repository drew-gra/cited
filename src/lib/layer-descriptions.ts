import type { LayerNumber } from "@/lib/api-types";

export const PREFLIGHT_PLAIN_DESCRIPTION =
  "Decides whether the URL is a real news outlet worth assessing";

export const LAYER_PLAIN_DESCRIPTION: Record<LayerNumber, string> = {
  1: "Analyzes publisher's instructions to AI",
  2: "Analyzes publisher's instructions to AI",
  3: "Analyzes publisher's technical stack",
  4: "Discovers whether publisher treats all AI traffic the same",
  5: "Queries Common Crawl for historic content",
};
