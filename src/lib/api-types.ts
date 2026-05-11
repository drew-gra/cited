import type { AiPlatform } from "./ai-platforms";
import type {
  AccessState,
  AggregatePosture,
  LayerStatus,
  RunStatus,
} from "./db/schema";
import type { RobotsLayer1Result } from "./layers/robots";

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
};

export type AssessRequestBody = {
  url: string;
  forceRefresh?: boolean;
};
