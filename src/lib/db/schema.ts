import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  integer,
  index,
  boolean,
} from "drizzle-orm/pg-core";

export type AccessState = "allowed" | "blocked" | "unknown";
export type AggregatePosture = "open" | "mixed" | "blocked" | "unknown";
export type LayerStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "skipped";
export type RunStatus = "pending" | "running" | "done" | "error";

// Outlets — one row per root domain.
export const outlets = pgTable("outlets", {
  id: uuid("id").primaryKey().defaultRandom(),
  rootDomain: text("root_domain").notNull().unique(),
  primaryUrl: text("primary_url").notNull(),
  firstAssessedAt: timestamp("first_assessed_at", { withTimezone: true }),
  lastFullAssessmentAt: timestamp("last_full_assessment_at", {
    withTimezone: true,
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Assessment runs — one row per user-initiated assessment job. Tracks
// per-layer status so the GET endpoint can render partial results.
// Schema deviation from brief: added to make the queue+poll UI tractable.
export const assessmentRuns = pgTable("assessment_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  outletId: uuid("outlet_id")
    .notNull()
    .references(() => outlets.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  layer1Status: text("layer1_status").notNull().default("pending"),
  layer2Status: text("layer2_status").notNull().default("pending"),
  layer3Status: text("layer3_status").notNull().default("pending"),
  layer4Status: text("layer4_status").notNull().default("pending"),
  layer5Status: text("layer5_status").notNull().default("pending"),
  errorMessage: text("error_message"),
  ipAddress: text("ip_address"),
  forceRefresh: boolean("force_refresh").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Assessments — one row per (outlet, platform, run).
// Schema deviation from brief: added assessmentRunId to associate the five
// per-platform rows that belong to the same run.
export const assessments = pgTable(
  "assessments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    assessmentRunId: uuid("assessment_run_id")
      .notNull()
      .references(() => assessmentRuns.id, { onDelete: "cascade" }),
    aiPlatform: text("ai_platform").notNull(),
    trainingAccess: text("training_access").notNull(),
    realtimeAccess: text("realtime_access").notNull(),
    searchAccess: text("search_access").notNull(),
    aggregatePosture: text("aggregate_posture").notNull(),
    confidence: integer("confidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    outletPlatformIdx: index("assessments_outlet_platform_idx").on(
      t.outletId,
      t.aiPlatform,
    ),
    runIdx: index("assessments_run_idx").on(t.assessmentRunId),
  }),
);

// Signals — raw evidence per layer, with TTL.
export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    layer: integer("layer").notNull(),
    signalType: text("signal_type").notNull(),
    signalValue: jsonb("signal_value").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ttlSeconds: integer("ttl_seconds").notNull(),
  },
  (t) => ({
    outletLayerIdx: index("signals_outlet_layer_idx").on(t.outletId, t.layer),
  }),
);

// Probe log — Layer 4 raw data (one row per UA probe).
export const probeLog = pgTable(
  "probe_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    outletId: uuid("outlet_id")
      .notNull()
      .references(() => outlets.id, { onDelete: "cascade" }),
    sampleUrl: text("sample_url").notNull(),
    userAgent: text("user_agent").notNull(),
    statusCode: integer("status_code"),
    responseSize: integer("response_size"),
    responseHash: text("response_hash"),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    outletIdx: index("probe_log_outlet_idx").on(t.outletId),
  }),
);

// Known relationships — Layer 6 input (deals, lawsuits, coalitions, grants).
// Empty in v1; populated by Layer 6 ingest later.
export const knownRelationships = pgTable("known_relationships", {
  id: uuid("id").primaryKey().defaultRandom(),
  outletId: uuid("outlet_id")
    .notNull()
    .references(() => outlets.id, { onDelete: "cascade" }),
  aiCompany: text("ai_company").notNull(),
  relationshipType: text("relationship_type").notNull(),
  sourceUrl: text("source_url").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// IP rate limits — backs the 20 fresh assessments / IP / hour cap.
// Schema deviation from brief: anti-abuse infrastructure not enumerated in the
// schema list but required by the spec.
export const ipRateLimits = pgTable(
  "ip_rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ipAddress: text("ip_address").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    ipTimeIdx: index("ip_rate_limits_ip_time_idx").on(
      t.ipAddress,
      t.createdAt,
    ),
  }),
);
