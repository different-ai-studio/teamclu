/**
 * Team env secrets — pg-repo implementation.
 *
 * Design: docs/architecture/team-mcp-and-env-cloud.md
 *
 * This repo deliberately knows nothing about the values it stores. The client
 * encrypts with the team key (AES-256-GCM, HKDF-SHA256 derived — see
 * crates/teamclu-runtime-env/src/team_crypto.rs) and uploads only the envelope
 * `{v, nonce, ciphertext}`. That is the same threat model the previous OSS/git
 * storage had — it defends against whoever runs the storage, not against
 * teammates — so moving the bytes to Postgres changes the transport, not the
 * guarantees.
 *
 * The practical consequence: every field the server needs for authorisation has
 * to be its own plaintext column. `description`, `category`, `createdBy` and
 * friends all live *inside* the ciphertext (SecretEntry), so the `created_by`
 * column here is not redundant with them — it is the only copy the server can
 * actually read when deciding who may delete a key.
 */

import { and, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { teamEnvSecrets } from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";
import { requireActorForTeam, resolveTeamRole } from "./authz.js";
import { assertWritableKeyId, readEnvelope } from "../validation/team-env-secrets.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

interface TeamEnvSecretsCtx {
  userId?: string;
}

const iso = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString() : null;

function mapSecret(row: any) {
  return {
    keyId: row.keyId,
    envelope: row.envelope,
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function makeTeamEnvSecretsRepo(db: DbLike, ctx: TeamEnvSecretsCtx) {
  function requireUser(): string {
    if (!ctx.userId) throw new ApiError(401, "unauthorized", "authentication required");
    return ctx.userId;
  }

  return {
    async listTeamEnvSecrets(teamId: string) {
      const userId = requireUser();
      await requireActorForTeam(db, userId, teamId);
      const rows = await db
        .select()
        .from(teamEnvSecrets)
        .where(eq(teamEnvSecrets.teamId, teamId))
        .orderBy(teamEnvSecrets.keyId);
      return rows.map(mapSecret);
    },

    /** Upsert. Editing an existing value is a normal member action. */
    async putTeamEnvSecret(teamId: string, keyId: string, body: any = {}) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);
      assertWritableKeyId(keyId);
      const envelope = readEnvelope(body);

      const [row] = await (db.insert(teamEnvSecrets) as any)
        .values({
          teamId,
          keyId,
          envelope,
          createdBy: callerActorId,
          updatedBy: callerActorId,
        })
        .onConflictDoUpdate({
          target: [teamEnvSecrets.teamId, teamEnvSecrets.keyId],
          // createdBy is intentionally NOT overwritten: it is the delete gate,
          // and letting the last writer claim it would quietly hand deletion
          // rights to whoever edited most recently.
          set: { envelope, updatedBy: callerActorId, updatedAt: new Date() },
        })
        .returning();

      return mapSecret(row);
    },

    /**
     * Delete is narrower than update on purpose: changing a value is
     * collaboration, removing a key strips an env var from every member's
     * runtime. Creator or admin only.
     */
    async deleteTeamEnvSecret(teamId: string, keyId: string) {
      const userId = requireUser();
      const callerActorId = await requireActorForTeam(db, userId, teamId);

      const [row] = await db
        .select({ id: teamEnvSecrets.id, createdBy: teamEnvSecrets.createdBy })
        .from(teamEnvSecrets)
        .where(and(eq(teamEnvSecrets.teamId, teamId), eq(teamEnvSecrets.keyId, keyId)))
        .limit(1);
      if (!row) throw new ApiError(404, "not_found", `env secret not found: ${keyId}`);

      if (row.createdBy !== callerActorId) {
        const role = await resolveTeamRole(db, userId, teamId);
        if (role !== "owner" && role !== "admin") {
          throw new ApiError(
            403,
            "forbidden",
            "only the key's creator or a team admin may delete it",
          );
        }
      }

      await db.delete(teamEnvSecrets).where(eq(teamEnvSecrets.id, row.id));
    },
  };
}
