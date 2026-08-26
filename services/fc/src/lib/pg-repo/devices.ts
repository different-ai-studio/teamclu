/**
 * Device pairing — pg-repo wrapper.
 *
 * DB writes go through the shared service-role pairing module (amux schema).
 * Membership is checked here first, matching the supabase-repo path.
 */
import type { PgDatabase } from "drizzle-orm/pg-core";
import { ApiError } from "../http-utils.js";
import { requireActorForTeam } from "./authz.js";
import { createDevicePairingCode as storePairingCode } from "../device-pairing.js";
import { actors } from "../../db/schema/index.js";
import { and, eq } from "drizzle-orm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

export interface DevicesRepoDeps {
  userId?: string;
}

export function makeDevicesRepo(db: DbLike, deps: DevicesRepoDeps = {}) {
  return {
    async createDevicePairingCode(input: {
      code: string;
      teamId: string;
      actorId: string;
      ttlSeconds?: number;
    }) {
      const createdBy = await requireActorForTeam(db, deps.userId ?? "", input.teamId);

      const [actor] = await db
        .select({ id: actors.id, teamId: actors.teamId })
        .from(actors)
        .where(and(eq(actors.id, input.actorId), eq(actors.teamId, input.teamId)))
        .limit(1);
      if (!actor) {
        throw new ApiError(404, "actor_not_found", "actor not found in this team");
      }

      return storePairingCode({
        code: input.code,
        teamId: input.teamId,
        actorId: input.actorId,
        ttlSeconds: input.ttlSeconds,
        createdBy,
      });
    },
  };
}
