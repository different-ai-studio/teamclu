import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { teams, actors } from "./teams.js";

// Mirrors services/supabase/migrations/20260806000000_team_skills_registry.sql
// + marketplace columns from 20260821000000_skills_marketplace.sql.
// Design: docs/architecture/team-skills-registry.md
//         docs/architecture/skills-marketplace.md

export const teamSkills = pgTable(
  "team_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    // Nullable + set null: an unowned skill is a real, meaningful state ("the
    // owner left, somebody claim this"), and `restrict` here would make
    // deleting a team fail outright.
    ownerActorId: uuid("owner_actor_id").references(() => actors.id, { onDelete: "set null" }),
    summary: text("summary").notNull(),
    category: text("category").notNull(),
    whenToUse: text("when_to_use").notNull(),
    whenNotToUse: text("when_not_to_use").notNull(),
    requires: jsonb("requires"),
    status: text("status").notNull().default("published"),
    supersededBy: text("superseded_by"),
    latestVersion: integer("latest_version").notNull().default(0),
    createdBy: uuid("created_by").references(() => actors.id, { onDelete: "set null" }),
    // Marketplace origin (skills-marketplace.md §4.3).
    origin: text("origin").notNull().default("local"),
    upstreamSlug: text("upstream_slug"),
    upstreamSubscribed: boolean("upstream_subscribed").notNull().default(false),
    upstreamDetachedAt: timestamp("upstream_detached_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    teamSlugUniq: uniqueIndex("uniq_team_skills_team_slug").on(t.teamId, t.slug),
    teamStatusIdx: index("idx_team_skills_team_status").on(t.teamId, t.status),
    ownerIdx: index("idx_team_skills_owner").on(t.ownerActorId),
    upstreamSlugIdx: index("idx_team_skills_upstream_slug_marketplace").on(t.upstreamSlug),
  }),
);

export const teamSkillVersions = pgTable(
  "team_skill_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => teamSkills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    contentHash: text("content_hash").notNull(),
    size: bigint("size", { mode: "number" }).notNull().default(0),
    changelog: text("changelog").notNull(),
    summary: text("summary").notNull(),
    category: text("category"),
    whenToUse: text("when_to_use").notNull(),
    whenNotToUse: text("when_not_to_use").notNull(),
    requires: jsonb("requires"),
    createdBy: uuid("created_by").references(() => actors.id, { onDelete: "set null" }),
    /** Baseline version the publisher's working copy was built from (audit). */
    publishedFromVersion: integer("published_from_version"),
    upstreamVersion: integer("upstream_version"),
    blobScope: text("blob_scope").notNull().default("team"),
    objectPath: text("object_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    skillVersionUniq: uniqueIndex("uniq_team_skill_version").on(t.skillId, t.version),
    skillVersionIdx: index("idx_team_skill_versions_skill").on(t.skillId, t.version),
  }),
);

export const teamSkillInstalls = pgTable(
  "team_skill_installs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // Generalises over both install subjects: a member actor installing for
    // themselves, and a visibility='team' agent actor an admin installs for.
    actorId: uuid("actor_id")
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => teamSkills.id, { onDelete: "cascade" }),
    installedVersion: integer("installed_version").notNull(),
    scope: text("scope").notNull().default("global"),
    workspaceId: uuid("workspace_id"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // The real index (see the migration) coalesces workspace_id so NULL rows
    // collide; drizzle-kit cannot express an expression index, and the SQL
    // migration is authoritative here, so this models the column tuple only.
    installUniq: uniqueIndex("uniq_team_skill_install").on(
      t.actorId,
      t.skillId,
      t.scope,
      t.workspaceId,
    ),
    actorIdx: index("idx_team_skill_installs_actor").on(t.actorId),
    skillIdx: index("idx_team_skill_installs_skill").on(t.skillId),
  }),
);
