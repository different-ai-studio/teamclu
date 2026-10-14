CREATE TABLE IF NOT EXISTS "amuxc_path_acl_role_grants" (
	"acl_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "amuxc_path_acl_role_grants_pkey" PRIMARY KEY("acl_id","role_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "amuxc_path_acl_role_grants" ADD CONSTRAINT "amuxc_path_acl_role_grants_acl_id_fkey" FOREIGN KEY ("acl_id") REFERENCES "public"."amuxc_path_acl"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "amuxc_path_acl_role_grants" ADD CONSTRAINT "amuxc_path_acl_role_grants_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "amuxc_path_acl_role_grants" ADD CONSTRAINT "amuxc_path_acl_role_grants_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."actors"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_amuxc_path_acl_role_grants_role" ON "amuxc_path_acl_role_grants" USING btree ("role_id");
--> statement-breakpoint
ALTER TABLE "amuxc_path_acl_role_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ONLY "amuxc_path_acl_role_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "amuxc_path_acl_role_grants" TO service_role;
