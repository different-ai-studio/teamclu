ALTER TABLE "amuxc_path_acl" DROP CONSTRAINT IF EXISTS "amuxc_path_acl_prefix_shape";
--> statement-breakpoint
ALTER TABLE "amuxc_path_acl" ADD CONSTRAINT "amuxc_path_acl_prefix_shape" CHECK (("path_prefix" LIKE 'knowledge/%' OR "path_prefix" LIKE 'documents/%') AND "path_prefix" LIKE '%/');
