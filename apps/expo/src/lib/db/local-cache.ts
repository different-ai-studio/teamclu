/**
 * SQLite-backed local cache — the durable read model iOS gets from SwiftData.
 *
 * Everything here answers one question: what can the app show before (or
 * without) the network? Sessions and messages used to live in whole-blob
 * AsyncStorage entries clamped to 200 rows, rewritten in full on every change;
 * ideas, actors, workspaces and shortcuts were not cached at all, so those
 * screens came up empty offline where iOS shows last-known state.
 *
 * Writes are "replace this scope with these rows" rather than row-level diffs.
 * The Cloud API hands back full lists, the caller has already reconciled them,
 * and a diff would only add a way for the cache to disagree with the server.
 */

export type CacheDb = {
  runAsync: (sql: string, ...params: unknown[]) => Promise<unknown>;
  getAllAsync: (sql: string, ...params: unknown[]) => Promise<Record<string, unknown>[]>;
  withTransactionAsync?: (task: () => Promise<void>) => Promise<void>;
};

const str = (value: unknown, fallback = ""): string =>
  value === null || value === undefined ? fallback : String(value);
const num = (value: unknown, fallback = 0): number =>
  value === null || value === undefined ? fallback : Number(value);
const nullableStr = (value: unknown): string | null =>
  value === null || value === undefined || value === "" ? null : String(value);
const json = <T,>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
};

/**
 * Run `task` inside a transaction when the driver offers one.
 *
 * A scope replace is a delete followed by N inserts; without a transaction a
 * crash between the two leaves the cache emptier than it was, which is worse
 * than leaving it stale. The fallback path exists for the plain object used in
 * tests.
 */
async function inTransaction(db: CacheDb, task: () => Promise<void>): Promise<void> {
  if (db.withTransactionAsync) {
    await db.withTransactionAsync(task);
    return;
  }
  await task();
}

async function replaceScope(
  db: CacheDb,
  args: {
    table: string;
    scopeColumn: string;
    scopeValue: string;
    columns: string[];
    rows: ReadonlyArray<ReadonlyArray<unknown>>;
  },
): Promise<void> {
  const placeholders = args.columns.map(() => "?").join(", ");
  await inTransaction(db, async () => {
    await db.runAsync(
      `DELETE FROM ${args.table} WHERE ${args.scopeColumn} = ?`,
      args.scopeValue,
    );
    for (const row of args.rows) {
      await db.runAsync(
        `INSERT OR REPLACE INTO ${args.table} (${args.columns.join(", ")}) VALUES (${placeholders})`,
        ...row,
      );
    }
  });
}

// ── Sessions ────────────────────────────────────────────────────────────────

export type CachedSession = {
  sessionId: string;
  teamId: string;
  title: string;
  summary: string;
  participantCount: number;
  participantActorIds: string[];
  lastMessagePreview: string;
  lastMessageAt: string;
  createdAt: string;
  createdBy: string;
  hasUnread: boolean;
};

const SESSION_COLUMNS = [
  "session_id", "team_id", "title", "summary", "participant_count",
  "participant_actor_ids", "last_message_preview", "last_message_at",
  "created_at", "created_by", "has_unread", "cached_at",
];

export async function saveSessions(
  db: CacheDb,
  teamId: string,
  sessions: ReadonlyArray<CachedSession>,
  now = Date.now(),
): Promise<void> {
  if (!teamId) return;
  await replaceScope(db, {
    table: "cached_sessions",
    scopeColumn: "team_id",
    scopeValue: teamId,
    columns: SESSION_COLUMNS,
    rows: sessions.map((s) => [
      s.sessionId, teamId, s.title, s.summary, s.participantCount,
      JSON.stringify(s.participantActorIds ?? []), s.lastMessagePreview,
      s.lastMessageAt, s.createdAt, s.createdBy, s.hasUnread ? 1 : 0, now,
    ]),
  });
}

export async function loadSessions(db: CacheDb, teamId: string): Promise<CachedSession[]> {
  if (!teamId) return [];
  const rows = await db.getAllAsync(
    "SELECT * FROM cached_sessions WHERE team_id = ? ORDER BY last_message_at DESC",
    teamId,
  );
  return rows.map((raw) => ({
    sessionId: str(raw.session_id),
    teamId: str(raw.team_id),
    title: str(raw.title),
    summary: str(raw.summary),
    participantCount: num(raw.participant_count),
    participantActorIds: json<string[]>(raw.participant_actor_ids, []),
    lastMessagePreview: str(raw.last_message_preview),
    lastMessageAt: str(raw.last_message_at),
    createdAt: str(raw.created_at),
    createdBy: str(raw.created_by),
    hasUnread: num(raw.has_unread) === 1,
  }));
}

// ── Messages ────────────────────────────────────────────────────────────────

export type CachedMessage = {
  messageId: string;
  sessionId: string;
  teamId: string;
  senderActorId: string;
  kind: string;
  content: string;
  model: string;
  turnId: string;
  replyToMessageId: string;
  metadata: unknown;
  attachments: unknown[];
  createdAt: string;
};

const MESSAGE_COLUMNS = [
  "message_id", "session_id", "team_id", "sender_actor_id", "kind", "content",
  "model", "turn_id", "reply_to_message_id", "metadata", "attachments",
  "created_at", "cached_at",
];

function messageRow(sessionId: string, m: CachedMessage, now: number): unknown[] {
  return [
    m.messageId, sessionId, m.teamId, m.senderActorId, m.kind, m.content,
    m.model, m.turnId, m.replyToMessageId,
    m.metadata == null ? null : JSON.stringify(m.metadata),
    JSON.stringify(m.attachments ?? []), m.createdAt, now,
  ];
}

export async function saveMessages(
  db: CacheDb,
  sessionId: string,
  messages: ReadonlyArray<CachedMessage>,
  now = Date.now(),
): Promise<void> {
  if (!sessionId) return;
  await replaceScope(db, {
    table: "cached_messages",
    scopeColumn: "session_id",
    scopeValue: sessionId,
    columns: MESSAGE_COLUMNS,
    rows: messages.map((m) => messageRow(sessionId, m, now)),
  });
}

/**
 * Writes `messages` without touching the session's other rows. For a timeline
 * that only grew or changed in place, this is the whole of what `saveMessages`
 * would rewrite, minus every row that did not change.
 */
export async function upsertMessages(
  db: CacheDb,
  sessionId: string,
  messages: ReadonlyArray<CachedMessage>,
  now = Date.now(),
): Promise<void> {
  if (!sessionId || messages.length === 0) return;
  const placeholders = MESSAGE_COLUMNS.map(() => "?").join(", ");
  await inTransaction(db, async () => {
    for (const m of messages) {
      await db.runAsync(
        `INSERT OR REPLACE INTO cached_messages (${MESSAGE_COLUMNS.join(", ")}) VALUES (${placeholders})`,
        ...messageRow(sessionId, m, now),
      );
    }
  });
}

export async function loadMessages(
  db: CacheDb,
  sessionId: string,
): Promise<CachedMessage[]> {
  if (!sessionId) return [];
  const rows = await db.getAllAsync(
    "SELECT * FROM cached_messages WHERE session_id = ? ORDER BY created_at ASC, message_id ASC",
    sessionId,
  );
  return rows.map((raw) => ({
    messageId: str(raw.message_id),
    sessionId: str(raw.session_id),
    teamId: str(raw.team_id),
    senderActorId: str(raw.sender_actor_id),
    kind: str(raw.kind, "text"),
    content: str(raw.content),
    model: str(raw.model),
    turnId: str(raw.turn_id),
    replyToMessageId: str(raw.reply_to_message_id),
    metadata: raw.metadata == null ? null : json<unknown>(raw.metadata, null),
    attachments: json<unknown[]>(raw.attachments, []),
    createdAt: str(raw.created_at),
  }));
}

/**
 * Every cached chat message and agent reply in a team, for the session list's
 * search by message content (iOS #1709). Only this device's cache is searched.
 */
export async function loadSearchableMessages(
  db: CacheDb,
  teamId: string,
): Promise<Array<{ sessionId: string; content: string }>> {
  if (!teamId) return [];
  const rows = await db.getAllAsync(
    "SELECT session_id, content FROM cached_messages WHERE team_id = ? AND kind IN ('text', 'agent_reply')",
    teamId,
  );
  return rows.map((raw) => ({ sessionId: str(raw.session_id), content: str(raw.content) }));
}

// ── Ideas ───────────────────────────────────────────────────────────────────

export type CachedIdea = {
  ideaId: string;
  teamId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  createdByActorId: string | null;
  title: string;
  description: string;
  status: string;
  archived: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

const IDEA_COLUMNS = [
  "idea_id", "team_id", "workspace_id", "workspace_name", "created_by_actor_id",
  "title", "description", "status", "archived", "sort_order", "created_at",
  "updated_at", "cached_at",
];

export async function saveIdeas(
  db: CacheDb,
  teamId: string,
  ideas: ReadonlyArray<CachedIdea>,
  now = Date.now(),
): Promise<void> {
  if (!teamId) return;
  await replaceScope(db, {
    table: "cached_ideas",
    scopeColumn: "team_id",
    scopeValue: teamId,
    columns: IDEA_COLUMNS,
    rows: ideas.map((i) => [
      i.ideaId, teamId, i.workspaceId, i.workspaceName, i.createdByActorId,
      i.title, i.description, i.status, i.archived ? 1 : 0, i.sortOrder,
      i.createdAt, i.updatedAt, now,
    ]),
  });
}

export async function loadIdeas(db: CacheDb, teamId: string): Promise<CachedIdea[]> {
  if (!teamId) return [];
  const rows = await db.getAllAsync(
    "SELECT * FROM cached_ideas WHERE team_id = ? ORDER BY sort_order ASC, updated_at DESC",
    teamId,
  );
  return rows.map((raw) => ({
    ideaId: str(raw.idea_id),
    teamId: str(raw.team_id),
    workspaceId: nullableStr(raw.workspace_id),
    workspaceName: nullableStr(raw.workspace_name),
    createdByActorId: nullableStr(raw.created_by_actor_id),
    title: str(raw.title),
    description: str(raw.description),
    status: str(raw.status, "open"),
    archived: num(raw.archived) === 1,
    sortOrder: num(raw.sort_order),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  }));
}

// ── Actors ──────────────────────────────────────────────────────────────────

export type CachedActorRow = {
  actorId: string;
  teamId: string;
  actorType: string;
  displayName: string;
  role: string | null;
  lastActiveAt: string | null;
  avatarUrl: string | null;
  agentTypes: string[];
  defaultAgentType: string | null;
  defaultWorkspaceId: string | null;
  ownerMemberId: string | null;
  visibility: string | null;
  agentKind: string | null;
  memberStatus: string | null;
  agentStatus: string | null;
  email: string | null;
  phone: string | null;
  createdAt: string | null;
};

const ACTOR_COLUMNS = [
  "actor_id", "team_id", "actor_type", "display_name", "role", "last_active_at",
  "avatar_url", "agent_types", "default_agent_type", "default_workspace_id",
  "owner_member_id", "visibility", "agent_kind", "member_status", "agent_status",
  "email", "phone", "created_at", "cached_at",
];

export async function saveActors(
  db: CacheDb,
  teamId: string,
  actors: ReadonlyArray<CachedActorRow>,
  now = Date.now(),
): Promise<void> {
  if (!teamId) return;
  await replaceScope(db, {
    table: "cached_actors",
    scopeColumn: "team_id",
    scopeValue: teamId,
    columns: ACTOR_COLUMNS,
    rows: actors.map((a) => [
      a.actorId, teamId, a.actorType, a.displayName, a.role, a.lastActiveAt,
      a.avatarUrl, JSON.stringify(a.agentTypes ?? []), a.defaultAgentType,
      a.defaultWorkspaceId, a.ownerMemberId, a.visibility, a.agentKind,
      a.memberStatus, a.agentStatus, a.email, a.phone, a.createdAt, now,
    ]),
  });
}

export async function loadActors(db: CacheDb, teamId: string): Promise<CachedActorRow[]> {
  if (!teamId) return [];
  const rows = await db.getAllAsync(
    "SELECT * FROM cached_actors WHERE team_id = ? ORDER BY display_name ASC",
    teamId,
  );
  return rows.map((raw) => ({
    actorId: str(raw.actor_id),
    teamId: str(raw.team_id),
    actorType: str(raw.actor_type, "member"),
    displayName: str(raw.display_name),
    role: nullableStr(raw.role),
    lastActiveAt: nullableStr(raw.last_active_at),
    avatarUrl: nullableStr(raw.avatar_url),
    agentTypes: json<string[]>(raw.agent_types, []),
    defaultAgentType: nullableStr(raw.default_agent_type),
    defaultWorkspaceId: nullableStr(raw.default_workspace_id),
    ownerMemberId: nullableStr(raw.owner_member_id),
    visibility: nullableStr(raw.visibility),
    agentKind: nullableStr(raw.agent_kind),
    memberStatus: nullableStr(raw.member_status),
    agentStatus: nullableStr(raw.agent_status),
    email: nullableStr(raw.email),
    phone: nullableStr(raw.phone),
    createdAt: nullableStr(raw.created_at),
  }));
}

// ── Workspaces ──────────────────────────────────────────────────────────────

export type CachedWorkspace = {
  id: string;
  teamId: string;
  name: string;
  path: string | null;
  agentId: string | null;
  archived: boolean;
};

export async function saveWorkspaces(
  db: CacheDb,
  teamId: string,
  workspaces: ReadonlyArray<CachedWorkspace>,
  now = Date.now(),
): Promise<void> {
  if (!teamId) return;
  await replaceScope(db, {
    table: "cached_workspaces",
    scopeColumn: "team_id",
    scopeValue: teamId,
    columns: ["workspace_id", "team_id", "name", "path", "agent_id", "archived", "cached_at"],
    rows: workspaces.map((w) => [
      w.id, teamId, w.name, w.path, w.agentId, w.archived ? 1 : 0, now,
    ]),
  });
}

export async function loadWorkspaces(
  db: CacheDb,
  teamId: string,
): Promise<CachedWorkspace[]> {
  if (!teamId) return [];
  const rows = await db.getAllAsync(
    "SELECT * FROM cached_workspaces WHERE team_id = ? ORDER BY name ASC",
    teamId,
  );
  return rows.map((raw) => ({
    id: str(raw.workspace_id),
    teamId: str(raw.team_id),
    name: str(raw.name),
    path: nullableStr(raw.path),
    agentId: nullableStr(raw.agent_id),
    archived: num(raw.archived) === 1,
  }));
}

// ── Shortcuts ───────────────────────────────────────────────────────────────

export type CachedShortcut = {
  id: string;
  teamId: string;
  scope: string;
  label: string;
  icon: string | null;
  parentId: string | null;
  target: unknown;
  sortOrder: number;
  /** "folder" | "url" | "team" | "session" | "external". */
  nodeType: string;
};

export async function saveShortcuts(
  db: CacheDb,
  teamId: string,
  shortcuts: ReadonlyArray<CachedShortcut>,
  now = Date.now(),
): Promise<void> {
  if (!teamId) return;
  await replaceScope(db, {
    table: "cached_shortcuts",
    scopeColumn: "team_id",
    scopeValue: teamId,
    columns: ["shortcut_id", "team_id", "scope", "label", "icon", "parent_id", "target", "sort_order", "node_type", "cached_at"],
    rows: shortcuts.map((s) => [
      s.id, teamId, s.scope, s.label, s.icon, s.parentId,
      s.target == null ? null : JSON.stringify(s.target), s.sortOrder, s.nodeType, now,
    ]),
  });
}

export async function loadShortcuts(
  db: CacheDb,
  teamId: string,
): Promise<CachedShortcut[]> {
  if (!teamId) return [];
  const rows = await db.getAllAsync(
    "SELECT * FROM cached_shortcuts WHERE team_id = ? ORDER BY sort_order ASC, label ASC",
    teamId,
  );
  return rows.map((raw) => ({
    id: str(raw.shortcut_id),
    teamId: str(raw.team_id),
    scope: str(raw.scope),
    label: str(raw.label),
    icon: nullableStr(raw.icon),
    parentId: nullableStr(raw.parent_id),
    target: raw.target == null ? null : json<unknown>(raw.target, null),
    sortOrder: num(raw.sort_order),
    nodeType: str(raw.node_type, "url"),
  }));
}

/** Drop every cached row for a team. Used on sign-out and on team removal. */
export async function clearTeamCache(db: CacheDb, teamId: string): Promise<void> {
  if (!teamId) return;
  await inTransaction(db, async () => {
    for (const table of [
      "cached_sessions", "cached_ideas", "cached_actors",
      "cached_workspaces", "cached_shortcuts",
    ]) {
      await db.runAsync(`DELETE FROM ${table} WHERE team_id = ?`, teamId);
    }
    await db.runAsync("DELETE FROM cached_messages WHERE team_id = ?", teamId);
  });
}
