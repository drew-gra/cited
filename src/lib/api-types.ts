import type { AiPlatform } from "./ai-platforms";
import type {
  AccessState,
  AggregatePosture,
  LayerStatus,
  RunStatus,
} from "./db/schema";
import type { RobotsLayer1Result } from "./layers/robots";
import type { L2Result } from "./layers/declarations";
import type { L3Result } from "./layers/cdn";
import type { L4Result } from "./layers/ua-probing";
import type { L5Result } from "./layers/common-crawl";
import type { LayerVerdict } from "./verdicts";
import type { ConfidenceBand } from "./posture";

export type LayerNumber = 1 | 2 | 3 | 4 | 5;

export type LayerSnapshot = {
  status: LayerStatus;
  capturedAt: string | null;
  ttlSeconds: number | null;
  isStale: boolean;
};

export type PlatformAssessment = {
  platform: AiPlatform;
  trainingAccess: AccessState;
  realtimeAccess: AccessState;
  searchAccess: AccessState;
  aggregatePosture: AggregatePosture;
  confidence: number;
  confidenceBand: ConfidenceBand;
};

export type AssessResponse = {
  id: string;
  outlet: {
    rootDomain: string;
    primaryUrl: string;
  };
  run: {
    status: RunStatus;
    layers: Record<LayerNumber, LayerSnapshot>;
    errorMessage: string | null;
    createdAt: string;
    updatedAt: string;
  };
  assessments: PlatformAssessment[];
  layer1Signal: RobotsLayer1Result | null;
  layer2Signal: L2Result | null;
  layer3Signal: L3Result | null;
  layer4Signal: L4Result | null;
  layer5Signal: L5Result | null;
  verdicts: LayerVerdict[];
};

export type AssessRequestBody = {
  url: string;
  forceRefresh?: boolean;
};
