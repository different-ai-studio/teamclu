-- Mirrors services/supabase/migrations/20260827000000_apps_self_serve_gitea.sql
-- (columns + app_secrets table only — the RLS/grant statements there have no
-- pg-repo counterpart, same convention as 0019_agents_device_identity.sql).

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "git_commit_sha" text;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "runtime" text DEFAULT 'node' NOT NULL;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "auth_mode" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "oauth_client_id" text;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "oauth_app_id" uuid;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "deploy_token" text;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "deploy_started_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_secrets" (
	"app_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_secrets_app_id_kind_pk" PRIMARY KEY("app_id","kind")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_secrets" ADD CONSTRAINT "app_secrets_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
