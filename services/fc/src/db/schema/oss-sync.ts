import {
  pgTable,
  uuid,
  text,
  boolean,
  bigint,
  integer,
  varchar,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { teams } from "./teams.js";
import { actors } from "./teams.js";

// ===========================================================================
// amuxc_blobs: content-addressed blob registry, per-team isolated
// ===========================================================================
export const amuxcBlobs = pgTable(
  "amuxc_blobs",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    ossKey: text("oss_key").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    verified: boolean("verified").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.teamId, t.contentHash] }),
    verifiedCreatedIdx: index("idx_amuxc_blobs_verified_created")
      .on(t.createdAt)
      .where(sql`verified = false`),
  })
);

// ===========================================================================
// amuxc_files: current pointer per path
// ===========================================================================
export const amuxcFiles = pgTable(
  "amuxc_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    currentVersion: integer("current_version").notNull().default(0),
    contentHash: text("content_hash"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    deleted: boolean("deleted").notNull().default(false),
    changeSeq: bigint("change_seq", { mode: "number" }).notNull().default(0),
    rowVersion: integer("row_version").notNull().default(0),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => actors.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pathUniq: uniqueIndex("uniq_amuxc_path").on(t.teamId, t.path),
    teamUpdatedIdx: index("idx_amuxc_files_team_updated").on(
      t.teamId,
      t.updatedAt
    ),
    teamSeqIdx: index("idx_amuxc_files_team_seq").on(t.teamId, t.changeSeq),
  })
);

// ===========================================================================
// amuxc_file_versions: append-only history
// ===========================================================================
export const amuxcFileVersions = pgTable(
  "amuxc_file_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => amuxcFiles.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    parentVersion: integer("parent_version").notNull(),
    contentHash: text("content_hash"),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    deleted: boolean("deleted").notNull().default(false),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => actors.id, { onDelete: "restrict" }),
    createdByNodeId: text("created_by_node_id"),
    message: text("message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    fileVersionUniq: uniqueIndex("uniq_amuxc_file_version").on(
      t.fileId,
      t.version
    ),
    fileVersionIdx: index("idx_amuxc_file_versions_file").on(
      t.fileId,
      t.version
    ),
  })
);

// ===========================================================================
// amuxc_upload_sessions: prepare/complete bridge
// ===========================================================================
export const amuxcUploadSessions = pgTable(
  "amuxc_upload_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    nodeId: text("node_id"),
    path: text("path").notNull(),
    parentVersion: integer("parent_version").notNull(),
    contentHash: text("content_hash").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    ossKey: text("oss_key").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresIdx: index("idx_amuxc_sessions_expires").on(t.expiresAt),
    teamStatusIdx: index("idx_amuxc_sessions_team_status").on(
      t.teamId,
      t.status
    ),
  })
);

// ===========================================================================
// amuxc_path_acl: restricted knowledge prefixes (whitelist semantics)
//
// A prefix listed here is closed to every actor without a matching grant. No
// rows for a team => that team is unrestricted, and the read paths skip every
// ACL query entirely (see sync-acl.ts).
//
// `pathPrefix` is itself sensitive — it is a directory name — which is why it
// is never sent to clients and why the tables carry RLS with no policy.
// See docs/specs/2026-08-31-knowledge-path-acl-design.md (D5, D7).
// ===========================================================================
export const amuxcPathAcl = pgTable(
  "amuxc_path_acl",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** Always `knowledge/…/` — leading scope and trailing slash are CHECKed in SQL. */
    pathPrefix: text("path_prefix").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => actors.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    prefixUniq: uniqueIndex("amuxc_path_acl_prefix_uniq").on(t.teamId, t.pathPrefix),
    teamIdx: index("idx_amuxc_path_acl_team").on(t.teamId),
  })
);

// ===========================================================================
// amuxc_path_acl_grants: who may see a restricted prefix
//
// A table rather than a uuid[] on amuxc_path_acl because grants are audit
// objects: an array cannot carry grantedBy/grantedAt.
// ===========================================================================
export const amuxcPathAclGrants = pgTable(
  "amuxc_path_acl_grants",
  {
    aclId: uuid("acl_id")
      .notNull()
      .references(() => amuxcPathAcl.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    /**
     * Reserved for the read-only axis. v1 does not read this column — reading
     * it would mean "read-only" is implemented, and it is not (design D3).
     */
    permissions: varchar("permissions", { length: 32 }).notNull().default("a:m:d"),
    grantedBy: uuid("granted_by")
      .notNull()
      .references(() => actors.id, { onDelete: "restrict" }),
    grantedAt: timestamp("granted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.aclId, t.actorId] }),
    actorIdx: index("idx_amuxc_path_acl_grants_actor").on(t.actorId),
  })
);

// ===========================================================================
// amuxc_access_log: audit trail for restricted content only
//
// Written only when a request touches a restricted prefix, so an unrestricted
// team produces no rows. Denials are recorded too — repeated probing of a
// directory someone cannot read is itself a signal.
// ===========================================================================
export const amuxcAccessLog = pgTable(
  "amuxc_access_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    /** The rule prefix that matched — not the full path. */
    pathPrefix: text("path_prefix").notNull(),
    /** Full path where the request names one; null for manifest. */
    path: text("path"),
    /** manifest | download | upload | delete | versions */
    action: text("action").notNull(),
    allowed: boolean("allowed").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    teamAtIdx: index("idx_amuxc_access_log_team_at").on(t.teamId, t.at),
    prefixIdx: index("idx_amuxc_access_log_prefix").on(t.teamId, t.pathPrefix, t.at),
  })
);

// ===========================================================================
// push_idempotency: dispatch dedup key
// ===========================================================================
export const pushIdempotency = pgTable("push_idempotency", {
  messageId: uuid("message_id").primaryKey(),
  claimedAt: timestamp("claimed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
