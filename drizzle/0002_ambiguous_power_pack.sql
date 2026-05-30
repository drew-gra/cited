CREATE TABLE "manual_blocklist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"root_domain" text NOT NULL,
	"reason" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_blocklist_root_domain_unique" UNIQUE("root_domain")
);
