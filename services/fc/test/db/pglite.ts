import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "../../src/db/schema/index.js";
import { TEAM_SKILLS_BOOTSTRAP } from "./team-skills-bootstrap.js";

// Build a fresh in-process Postgres (pglite) with the generated drizzle
// migrations applied. Returns the drizzle db handle (same schema as runtime).
export async function makeTestDb() {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  const migDir = join(dirname(fileURLToPath(import.meta.url)), "../../src/db/migrations");
  let files: string[] = [];
  try { files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort(); } catch { files = []; }
  for (const f of files) {
    const sql = readFileSync(join(migDir, f), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s) await pg.exec(s);
    }
  }
  // The skills registry tables ship in services/supabase/migrations, which this
  // harness does not replay. Created here rather than per-suite because they are
  // reachable from shared code — the orphan-blob collector reads
  // team_skill_versions to know which blobs are still spoken for — so a suite
  // that never mentions skills can still land on them.
  await pg.exec(TEAM_SKILLS_BOOTSTRAP);

  // Cast to any so callers can use the db handle without fighting
  // PgliteDatabase vs PostgresJsDatabase type variance
  return { db: db as any, pg };
}
