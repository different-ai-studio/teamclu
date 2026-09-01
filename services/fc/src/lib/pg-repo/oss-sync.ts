/**
 * OSS-Sync domain — pg-repo implementation.
 *
 * Replaces the Supabase RPCs:
 *   amuxc_complete_upload  → completeUpload  (CAS + waterline bump)
 *   amuxc_complete_delete  → completeDelete  (CAS + waterline bump)
 *
 * Waterline invariant (§2.6):
 *   Inside every write transaction, team_workspace_config.oss_change_seq is
 *   incremented FIRST so that any snapshot seeing seq=N is guaranteed to also
 *   see all amuxc_files rows with change_seq ≤ N (same atomic tx).
 */

import { and, desc, eq, gt, lt, notLike, or, sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import {
  amuxcBlobs,
  amuxcFiles,
  amuxcFileVersions,
  amuxcUploadSessions,
  teamWorkspaceConfig,
  teamMembers,
} from "../../db/schema/index.js";
import { ApiError } from "../http-utils.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbLike = PgDatabase<any, any>;

// ── public surface types ──────────────────────────────────────────────────────

export interface UploadPrepareInput {
  teamId: string;
  actorId: string;
  nodeId?: string | null;
  path: string;
  parentVersion: number;
  contentHash: string;
  size: number;
  ossKey: string;
  expiresAt: Date;
}

export interface CompleteUploadResult {
  version: number;
  contentHash: string;
  changeSeq: number;
}

export interface CompleteDeleteInput {
  teamId: string;
  path: string;
  parentVersion: number;
  actorId: string;
  nodeId?: string | null;
}

export interface CompleteDeleteResult {
  version: number;
  changeSeq: number;
}

export interface ManifestInput {
  teamId: string;
  afterSeq: number;
  snapshotSeq?: number;
  cursor?: string;
  limit?: number;
  /**
   * Knowledge prefixes the caller may not see (see lib/sync-acl.ts).
   *
   * Empty or omitted — the case for every team without ACL rules — leaves the
   * query byte-identical to what it was before per-directory ACL existed.
   */
  deniedPrefixes?: string[];
}

export interface ManifestFile {
  id: string;
  path: string;
  currentVersion: number;
  contentHash: string | null;
  size: number;
  deleted: boolean;
  changeSeq: number;
  updatedBy: string;
  updatedAt: string;
}

export interface ManifestResult {
  files: ManifestFile[];
  nextCursor?: string;
}

export interface VersionEntry {
  version: number;
  parentVersion: number;
  contentHash: string | null;
  size: number;
  deleted: boolean;
  createdBy: string;
  createdByNodeId: string | null;
  createdAt: string;
}

export interface VersionsResult {
  versions: VersionEntry[];
  nextCursor?: string;
}

// ── factory ───────────────────────────────────────────────────────────────────

export function makeOssSyncRepo(db: DbLike) {
  return {
    /**
     * Upsert a blob placeholder (verified=false) + create a pending upload session.
     * Returns the session id.
     */
    async uploadPrepare(input: UploadPrepareInput): Promise<string> {
      const {
        teamId, actorId, nodeId, path,
        parentVersion, contentHash, size, ossKey, expiresAt,
      } = input;

      // Upsert blob placeholder — if blob already exists (same content_hash),
      // keep the existing row (do nothing).
      await (db.insert(amuxcBlobs) as any)
        .values({ teamId, contentHash, ossKey, size, verified: false })
        .onConflictDoNothing();

      const [session] = await (db.insert(amuxcUploadSessions) as any).values({
        teamId,
        actorId,
        nodeId: nodeId ?? null,
        path,
        parentVersion,
        contentHash,
        size,
        ossKey,
        status: "pending",
        expiresAt,
      }).returning();

      return session.id;
    },

    /**
     * Get blob metadata (oss_key, size, verified) by (teamId, contentHash).
     * Returns null if not found.
     */
    async download({ teamId, contentHash }: { teamId: string; contentHash: string }) {
      const [row] = await db
        .select({ ossKey: amuxcBlobs.ossKey, size: amuxcBlobs.size, verified: amuxcBlobs.verified })
        .from(amuxcBlobs)
        .where(and(eq(amuxcBlobs.teamId, teamId), eq(amuxcBlobs.contentHash, contentHash)))
        .limit(1);
      return row ?? null;
    },

    /**
     * Atomic CAS upload-complete transaction (replaces amuxc_complete_upload RPC).
     *
     * Waterline invariant: oss_change_seq is bumped FIRST inside the transaction.
     * CAS: rejects with 409 if file.current_version !== session.parent_version.
     */
    async completeUpload(sessionId: string, actorId: string): Promise<CompleteUploadResult> {
      return db.transaction(async (tx: any) => {
        // 1. Load + lock session
        const [session] = await tx
          .select()
          .from(amuxcUploadSessions)
          .where(eq(amuxcUploadSessions.id, sessionId))
          .for("update")
          .limit(1);

        if (!session) throw new ApiError(404, "not_found", "upload session not found");
        if (session.actorId !== actorId) throw new ApiError(403, "forbidden", "session does not belong to caller");
        if (session.status !== "pending") throw new ApiError(410, "gone", `session is ${session.status}`);
        if (new Date(session.expiresAt) < new Date()) throw new ApiError(410, "gone", "session has expired");

        // 2. WATERLINE INVARIANT: bump oss_change_seq FIRST
        const [wcRow] = await tx
          .update(teamWorkspaceConfig)
          .set({ ossChangeSeq: sql`${teamWorkspaceConfig.ossChangeSeq} + 1` })
          .where(eq(teamWorkspaceConfig.teamId, session.teamId))
          .returning({ ossChangeSeq: teamWorkspaceConfig.ossChangeSeq });

        if (!wcRow) throw new ApiError(500, "internal", `team_workspace_config missing for team ${session.teamId}`);
        const vSeq: number = wcRow.ossChangeSeq;

        // 3. Ensure file row exists
        await (tx.insert(amuxcFiles) as any)
          .values({
            teamId: session.teamId,
            path: session.path,
            updatedBy: actorId,
          })
          .onConflictDoNothing();

        // 4. Lock file row
        const [file] = await tx
          .select()
          .from(amuxcFiles)
          .where(and(eq(amuxcFiles.teamId, session.teamId), eq(amuxcFiles.path, session.path)))
          .for("update")
          .limit(1);

        // 5. CAS check
        if (file.currentVersion !== session.parentVersion) {
          throw new ApiError(409, "conflict", `version conflict: remote=${file.currentVersion} expected=${session.parentVersion}`);
        }

        const newVersion = file.currentVersion + 1;

        // 6. Mark blob verified
        await tx
          .update(amuxcBlobs)
          .set({ verified: true })
          .where(and(eq(amuxcBlobs.teamId, session.teamId), eq(amuxcBlobs.contentHash, session.contentHash)));

        // 7. Append version record
        await tx.insert(amuxcFileVersions).values({
          fileId: file.id,
          version: newVersion,
          parentVersion: session.parentVersion,
          contentHash: session.contentHash,
          size: session.size,
          deleted: false,
          createdBy: actorId,
          createdByNodeId: session.nodeId ?? null,
        });

        // 8. Advance file pointer (upsert-style update)
        await tx
          .update(amuxcFiles)
          .set({
            currentVersion: newVersion,
            contentHash: session.contentHash,
            size: session.size,
            deleted: false,
            changeSeq: vSeq,
            rowVersion: sql`${amuxcFiles.rowVersion} + 1`,
            updatedBy: actorId,
            updatedAt: new Date(),
          })
          .where(eq(amuxcFiles.id, file.id));

        // 9. Mark session completed
        await tx
          .update(amuxcUploadSessions)
          .set({ status: "completed" })
          .where(eq(amuxcUploadSessions.id, sessionId));

        return { version: newVersion, contentHash: session.contentHash, changeSeq: vSeq };
      });
    },

    /**
     * Atomic delete tombstone transaction (replaces amuxc_complete_delete RPC).
     *
     * Waterline invariant: oss_change_seq bumped FIRST.
     * CAS: rejects with 409 if file.current_version !== parentVersion.
     */
    async completeDelete(input: CompleteDeleteInput): Promise<CompleteDeleteResult> {
      const { teamId, path, parentVersion, actorId, nodeId } = input;

      return db.transaction(async (tx: any) => {
        // 1. WATERLINE INVARIANT: bump oss_change_seq FIRST
        const [wcRow] = await tx
          .update(teamWorkspaceConfig)
          .set({ ossChangeSeq: sql`${teamWorkspaceConfig.ossChangeSeq} + 1` })
          .where(eq(teamWorkspaceConfig.teamId, teamId))
          .returning({ ossChangeSeq: teamWorkspaceConfig.ossChangeSeq });

        if (!wcRow) throw new ApiError(500, "internal", `team_workspace_config missing for team ${teamId}`);
        const vSeq: number = wcRow.ossChangeSeq;

        // 2. Lock file row
        const [file] = await tx
          .select()
          .from(amuxcFiles)
          .where(and(eq(amuxcFiles.teamId, teamId), eq(amuxcFiles.path, path)))
          .for("update")
          .limit(1);

        if (!file) throw new ApiError(404, "not_found", `file not found: ${path}`);

        // 3. CAS check
        if (file.currentVersion !== parentVersion) {
          throw new ApiError(409, "conflict", `version conflict: remote=${file.currentVersion} expected=${parentVersion}`);
        }

        const newVersion = file.currentVersion + 1;

        // 4. Append tombstone version record
        await tx.insert(amuxcFileVersions).values({
          fileId: file.id,
          version: newVersion,
          parentVersion,
          contentHash: null,
          size: 0,
          deleted: true,
          createdBy: actorId,
          createdByNodeId: nodeId ?? null,
        });

        // 5. Mark file as deleted and advance pointer
        await tx
          .update(amuxcFiles)
          .set({
            currentVersion: newVersion,
            contentHash: null,
            size: 0,
            deleted: true,
            changeSeq: vSeq,
            rowVersion: sql`${amuxcFiles.rowVersion} + 1`,
            updatedBy: actorId,
            updatedAt: new Date(),
          })
          .where(eq(amuxcFiles.id, file.id));

        return { version: newVersion, changeSeq: vSeq };
      });
    },

    /**
     * Manifest: list files (and tombstones) with change_seq > afterSeq.
     * Supports keyset cursor-based pagination ordered by (change_seq ASC, id ASC).
     * Cursor encodes the last seen (changeSeq, id) as "seq:id", enabling correct
     * pagination even when multiple files share the same change_seq.
     */
    async manifest(input: ManifestInput): Promise<ManifestResult> {
      const { teamId, afterSeq, cursor, limit = 200, deniedPrefixes = [] } = input;

      // Parse cursor: "changeSeq:id"
      let cursorSeq: number | null = null;
      let cursorId: string | null = null;
      if (cursor) {
        const colonIdx = cursor.indexOf(":");
        if (colonIdx !== -1) {
          cursorSeq = parseInt(cursor.slice(0, colonIdx), 10);
          cursorId = cursor.slice(colonIdx + 1);
        }
      }

      // Build WHERE: (change_seq > afterSeq) AND keyset (change_seq, id) > (cursorSeq, cursorId)
      // Keyset: change_seq > cursorSeq OR (change_seq = cursorSeq AND id > cursorId)
      // One NOT LIKE per restricted prefix. Prefixes always carry a trailing
      // slash, so `knowledge/hr/%` cannot match `knowledge/hr-public/…` — the
      // same property `matchPrefix` in sync-acl.ts relies on. Both matchers have
      // to agree about what a prefix covers, and that slash is why they do.
      const aclFilters = deniedPrefixes.map((prefix) =>
        notLike(amuxcFiles.path, `${prefix}%`),
      );

      const baseFilter = and(
        eq(amuxcFiles.teamId, teamId),
        gt(amuxcFiles.changeSeq, afterSeq),
        ...aclFilters,
      );

      const whereClause =
        cursorSeq != null && cursorId != null
          ? and(
              baseFilter,
              or(
                gt(amuxcFiles.changeSeq, cursorSeq),
                and(
                  sql`${amuxcFiles.changeSeq} = ${cursorSeq}`,
                  sql`${amuxcFiles.id} > ${cursorId}`,
                ),
              ),
            )
          : baseFilter;

      const rows = await db
        .select()
        .from(amuxcFiles)
        .where(whereClause)
        .orderBy(amuxcFiles.changeSeq, amuxcFiles.id)
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = page[page.length - 1] as any;

      return {
        files: page.map((r: any) => ({
          id: r.id,
          path: r.path,
          currentVersion: r.currentVersion,
          contentHash: r.contentHash ?? null,
          size: r.size,
          deleted: r.deleted,
          changeSeq: r.changeSeq,
          updatedBy: r.updatedBy,
          updatedAt: new Date(r.updatedAt).toISOString(),
        })),
        nextCursor: hasMore && lastRow ? `${lastRow.changeSeq}:${lastRow.id}` : undefined,
      };
    },

    /**
     * Version history for a specific file path.
     * Returns versions in descending order (newest first).
     */
    async versions(input: { teamId: string; path: string; cursor?: string; limit?: number }): Promise<VersionsResult> {
      const { teamId, path, cursor, limit = 50 } = input;

      const [file] = await db
        .select({ id: amuxcFiles.id })
        .from(amuxcFiles)
        .where(and(eq(amuxcFiles.teamId, teamId), eq(amuxcFiles.path, path)))
        .limit(1);

      if (!file) return { versions: [] };

      // Keyset cursor: versions ordered DESC; next page is WHERE version < cursorVersion
      const cursorVersion = cursor != null ? parseInt(cursor, 10) : null;
      const versionsWhere =
        cursorVersion != null && !isNaN(cursorVersion)
          ? and(eq(amuxcFileVersions.fileId, file.id), lt(amuxcFileVersions.version, cursorVersion))
          : eq(amuxcFileVersions.fileId, file.id);

      const rows = await db
        .select()
        .from(amuxcFileVersions)
        .where(versionsWhere)
        .orderBy(desc(amuxcFileVersions.version))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      return {
        versions: page.map((r: any) => ({
          version: r.version,
          parentVersion: r.parentVersion,
          contentHash: r.contentHash ?? null,
          size: r.size,
          deleted: r.deleted,
          createdBy: r.createdBy,
          createdByNodeId: r.createdByNodeId ?? null,
          createdAt: new Date(r.createdAt).toISOString(),
        })),
        nextCursor: hasMore ? page[page.length - 1]?.version?.toString() : undefined,
      };
    },

    /**
     * Sum of `size` over live (non-deleted) files for a team.
     * Empty team → 0. Used by the prepare byte-quota guard.
     */
    async sumLiveBytes(teamId: string): Promise<number> {
      const [row] = await db
        .select({
          total: sql<number>`coalesce(sum(${amuxcFiles.size}), 0)`,
        })
        .from(amuxcFiles)
        .where(and(eq(amuxcFiles.teamId, teamId), eq(amuxcFiles.deleted, false)));
      const n = row?.total;
      return typeof n === "number" && Number.isFinite(n) ? n : Number(n) || 0;
    },

    /**
     * Set team sync mode — only team owners may switch.
     * actorId must be a team owner (role='owner' in team_members).
     */
    async setTeamSyncMode(teamId: string, mode: "git" | "oss", actorId: string): Promise<void> {
      if (mode !== "git" && mode !== "oss") {
        throw new ApiError(400, "bad_request", `invalid sync_mode: ${mode}`);
      }

      // Check ownership
      const [membership] = await db
        .select({ role: teamMembers.role })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.memberId, actorId)))
        .limit(1);

      if (!membership) {
        throw new ApiError(403, "forbidden", "caller is not a member of this team");
      }
      if (membership.role !== "owner") {
        throw new ApiError(403, "forbidden", `only team owners may switch sync_mode (caller role=${membership.role})`);
      }

      await (db.update(teamWorkspaceConfig) as any)
        .set({ syncMode: mode, updatedAt: new Date() })
        .where(eq(teamWorkspaceConfig.teamId, teamId));
    },

    /**
     * Get team sync mode. Returns null if no workspace config exists.
     */
    async getTeamSyncMode(teamId: string): Promise<string | null> {
      const [row] = await db
        .select({ syncMode: teamWorkspaceConfig.syncMode })
        .from(teamWorkspaceConfig)
        .where(eq(teamWorkspaceConfig.teamId, teamId))
        .limit(1);
      return row?.syncMode ?? null;
    },
  };
}

export type OssSyncRepo = ReturnType<typeof makeOssSyncRepo>;
