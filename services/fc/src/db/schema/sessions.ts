import { pgTable, uuid, text, timestamp, unique } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";
import { actors } from "./teams.js";

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  teamId: uuid("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  ideaId: uuid("idea_id"),
  createdByActorId: uuid("created_by_actor_id"),
  primaryAgentId: uuid("primary_agent_id"),
  appId: uuid("app_id"),
  mode: text("mode").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull().default(""),
  lastMessagePreview: text("last_message_preview"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  /** ACP / gateway integration: used by getSessionByAcp */
  acpSessionId: text("acp_session_id"),
  /** Gateway binding key (unique per team); used by ensureGatewaySession.
   *  This is the "currently attached" pointer: detaching nulls it. */
  binding: text("binding"),
  /** The gateway chat a session belongs to, for the session's whole lifetime.
   *  Written at create time from the binding and never cleared, so a chat can
   *  still enumerate the sessions it detached from (`/sessions` → `/sessions n`). */
  gatewayKey: text("gateway_key"),
  /** How the session was created: 'user' (default) | 'cron' | 'gateway' | 'thread'. */
  source: text("source").notNull().default("user"),
  /** Parent session when source='thread' (forked agent-reply thread). */
  parentSessionId: uuid("parent_session_id").references((): typeof sessions.id => sessions.id, {
    onDelete: "cascade",
  }),
  /** Anchor agent_reply message when source='thread'. */
  threadRootMessageId: uuid("thread_root_message_id"),
  /** For source='cron': the desktop-local cron job id that created it
   *  (a daemon-local string id, not a cloud FK). */
  cronJobId: text("cron_job_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  teamBindingUniq: unique("sessions_team_binding_uniq").on(t.teamId, t.binding),
}));

export const sessionParticipants = pgTable("session_participants", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").notNull().references(() => actors.id, { onDelete: "cascade" }),
  role: text("role"),
  // An agent participant's working state for this session. NULL on member rows
  // — not applicable rather than missing. See ADR-0005.
  workspaceId: uuid("workspace_id"),
  model: text("model"),
  lastProcessedMessageId: uuid("last_processed_message_id"),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionActorUniq: unique("session_participants_session_actor_uniq").on(t.sessionId, t.actorId),
}));

export const sessionReadMarkers = pgTable("session_read_markers", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  actorId: uuid("actor_id").notNull().references(() => actors.id, { onDelete: "cascade" }),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  lastReadMessageId: uuid("last_read_message_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sessionActorUniq: unique("session_read_markers_session_actor_uniq").on(t.sessionId, t.actorId),
}));

export const sessionMutes = pgTable("session_mutes", {
  userId: text("user_id").notNull(),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  mutedAt: timestamp("muted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: unique("session_mutes_pk").on(t.userId, t.sessionId),
}));
