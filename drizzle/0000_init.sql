CREATE TABLE "assessment_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"layer1_status" text DEFAULT 'pending' NOT NULL,
	"layer2_status" text DEFAULT 'pending' NOT NULL,
	"layer3_status" text DEFAULT 'pending' NOT NULL,
	"layer4_status" text DEFAULT 'pending' NOT NULL,
	"layer5_status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"ip_address" text,
	"force_refresh" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"assessment_run_id" uuid NOT NULL,
	"ai_platform" text NOT NULL,
	"training_access" text NOT NULL,
	"realtime_access" text NOT NULL,
	"search_access" text NOT NULL,
	"aggregate_posture" text NOT NULL,
	"confidence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ip_rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "known_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"ai_company" text NOT NULL,
	"relationship_type" text NOT NULL,
	"source_url" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outlets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"root_domain" text NOT NULL,
	"primary_url" text NOT NULL,
	"first_assessed_at" timestamp with time zone,
	"last_full_assessment_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outlets_root_domain_unique" UNIQUE("root_domain")
);
--> statement-breakpoint
CREATE TABLE "probe_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"sample_url" text NOT NULL,
	"user_agent" text NOT NULL,
	"status_code" integer,
	"response_size" integer,
	"response_hash" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"layer" integer NOT NULL,
	"signal_type" text NOT NULL,
	"signal_value" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ttl_seconds" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessment_runs" ADD CONSTRAINT "assessment_runs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_assessment_run_id_assessment_runs_id_fk" FOREIGN KEY ("assessment_run_id") REFERENCES "public"."assessment_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "known_relationships" ADD CONSTRAINT "known_relationships_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_log" ADD CONSTRAINT "probe_log_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessments_outlet_platform_idx" ON "assessments" USING btree ("outlet_id","ai_platform");--> statement-breakpoint
CREATE INDEX "assessments_run_idx" ON "assessments" USING btree ("assessment_run_id");--> statement-breakpoint
CREATE INDEX "ip_rate_limits_ip_time_idx" ON "ip_rate_limits" USING btree ("ip_address","created_at");--> statement-breakpoint
CREATE INDEX "probe_log_outlet_idx" ON "probe_log" USING btree ("outlet_id");--> statement-breakpoint
CREATE INDEX "signals_outlet_layer_idx" ON "signals" USING btree ("outlet_id","layer");