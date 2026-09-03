import { create as createProto } from "@bufbuild/protobuf";
import { ActorSchema, ActorType, MessageKind, MessageSchema, type Message } from "@/lib/proto/teamclu_pb";
import {
  setLocalCacheCurrentTeam,
  upsertActorsBatch,
  upsertMessagesBatch,
  upsertSessionParticipantsBatch,
  upsertSessionsBatch,
  type ActorRow,
  type MessageRow,
  type SessionParticipantRow,
  type SessionRow,
} from "@/lib/local-cache";
import { isTauri } from "@/lib/utils";
import { useActorsStore } from "@/stores/actors-store";
import { useCurrentTeamStore } from "@/stores/current-team";
import { useSessionListStore, type SessionListEntry } from "@/stores/session-list-store";
import { useSessionStore } from "@/stores/session-store";
import { useUIStore } from "@/stores/ui";
import { useV2StreamingStore } from "@/stores/v2-streaming-store";
import { useWorkspaceStore } from "@/stores/workspace";
import { sortSessionListRows } from "@/lib/session-list-sort";
import {
  E2E_BUILD,
  isV2E2EControlActive,
  markV2E2EControlInstalled,
  setV2E2EControlActive,
} from "./v2-control-active";

type SeedActor = {
  id?: string;
  actorId?: string;
  actor_id?: string;
  type?: string;
  kind?: string;
  actorType?: string;
  actor_type?: string;
  displayName?: string;
  display_name?: string;
  avatarUrl?: string | null;
  avatar_url?: string | null;
  memberStatus?: string | null;
  member_status?: string | null;
  agentStatus?: string | null;
  agent_status?: string | null;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
};

type SeedSession = {
  id?: string;
  sessionId?: string;
  session_id?: string;
  title?: string;
  teamId?: string;
  team_id?: string;
  mode?: "solo" | "collab" | "control" | string | null;
  ideaId?: string | null;
  idea_id?: string | null;
  primaryAgentId?: string | null;
  primary_agent_id?: string | null;
  lastMessageAt?: string | null;
  last_message_at?: string | null;
  lastMessagePreview?: string | null;
  last_message_preview?: string | null;
  createdBy?: string | null;
  created_by?: string | null;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  participants?: Array<string | { actorId?: string; actor_id?: string; id?: string }>;
  participantActorIds?: string[];
  participant_actor_ids?: string[];
};

type SeedMessage = AppendMessageInput & {
  id?: string;
  created_at?: string | number;
  sender_actor_id?: string | null;
  reply_to_message_id?: string | null;
  metadata_json?: string | null;
  turn_id?: string | null;
};

type SeedConversationInput = {
  runId: string;
  teamId: string;
  workspacePath?: string | null;
  actors?: SeedActor[];
  sessions?: SeedSession[];
  messagesBySession?: Record<string, SeedMessage[]>;
  activeSessionId?: string | null;
};

type SeedConversationResult = {
  runId: string;
  warnings: string[];
};

type AppendMessageInput = {
  sessionId?: string;
  session_id?: string;
  messageId?: string;
  message_id?: string;
  senderActorId?: string | null;
  sender_actor_id?: string | null;
  kind?: MessageKind | string;
  content?: string;
  createdAt?: string | number;
  replyToMessageId?: string | null;
  reply_to_message_id?: string | null;
  mentions?: string[];
  model?: string | null;
  metadataJson?: string | null;
  metadata_json?: string | null;
  turnId?: string | null;
  turn_id?: string | null;
};

type StreamInput = {
  sessionId?: string;
  session_id?: string;
  actorId?: string;
  actor_id?: string;
};

type AgentDeltaInput = StreamInput & {
  delta?: string;
  text?: string;
  channel?: "output" | "thinking";
};

type ToolStartInput = StreamInput & {
  toolId?: string;
  tool_id?: string;
  toolName?: string;
  tool_name?: string;
  toolKind?: string;
  tool_kind?: string;
  description?: string;
  params?: Record<string, string>;
};

type ToolCompleteInput = StreamInput & {
  toolId?: string;
  tool_id?: string;
  success?: boolean;
  summary?: string;
};

type PermissionRequestInput = StreamInput & {
  requestId?: string;
  request_id?: string;
  toolName?: string;
  tool_name?: string;
  description?: string;
  params?: Record<string, string>;
};

type AgentErrorInput = StreamInput & {
  message?: string;
  details?: string;
};

type CompleteRunInput = StreamInput & {
  runId?: string;
  run_id?: string;
  messageId?: string;
  message_id?: string;
  content?: string;
  finalText?: string;
  final_text?: string;
  model?: string | null;
};

type NormalizedActor = {
  id: string;
  actorType: "member" | "agent";
  displayName: string;
  avatarUrl: string | null;
  memberStatus: string | null;
  agentStatus: string | null;
  createdAt: string;
  updatedAt: string;
};

type V2E2EControl = {
  seedConversation: (input: SeedConversationInput) => Promise<SeedConversationResult>;
  switchSession: (input: string | { sessionId?: string; session_id?: string }) => Promise<void>;
  appendMessage: (input: AppendMessageInput) => Promise<Message>;
  emitAgentDelta: (input: AgentDeltaInput) => void;
  startTool: (input: ToolStartInput) => void;
  completeTool: (input: ToolCompleteInput) => void;
  setPermissionRequest: (input: PermissionRequestInput) => void;
  setAgentError: (input: AgentErrorInput) => void;
  completeRun: (input: CompleteRunInput) => Promise<Message>;
  cleanup: () => void;
};

declare global {
  interface Window {
    __TEAMCLU_V2_E2E__?: V2E2EControl;
  }
}

const seededSessionIds = new Set<string>();
const seededActorIds = new Set<string>();
const seededRunIds = new Set<string>();
let seededSessionRows: SessionListEntry[] | null = null;
let internalMutationDepth = 0;

function withInternalMutation<T>(fn: () => T): T {
  internalMutationDepth += 1;
  try {
    return fn();
  } finally {
    internalMutationDepth -= 1;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function workspaceNameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || trimmed || "workspace";
}

function normalizeActor(input: SeedActor): NormalizedActor {
  const id = input.id ?? input.actorId ?? input.actor_id;
  if (!id) throw new Error("actor id is required");

  const rawType = (input.actorType ?? input.actor_type ?? input.kind ?? input.type ?? "member").toLowerCase();
  const actorType = rawType.includes("agent") ? "agent" : "member";
  const timestamp = nowIso();

  return {
    id,
    actorType,
    displayName: input.displayName ?? input.display_name ?? id,
    avatarUrl: input.avatarUrl ?? input.avatar_url ?? null,
    memberStatus: input.memberStatus ?? input.member_status ?? (actorType === "member" ? "active" : null),
    agentStatus: input.agentStatus ?? input.agent_status ?? (actorType === "agent" ? "idle" : null),
    createdAt: input.createdAt ?? input.created_at ?? timestamp,
    updatedAt: input.updatedAt ?? input.updated_at ?? timestamp,
  };
}

function actorProtoType(actorType: NormalizedActor["actorType"]): ActorType {
  return actorType === "agent" ? ActorType.ROLE_AGENT : ActorType.HUMAN;
}

function normalizeSession(input: SeedSession, teamId: string): SessionListEntry {
  const id = input.id ?? input.sessionId ?? input.session_id;
  if (!id) throw new Error("session id is required");

  return {
    id,
    title: input.title ?? id,
    team_id: input.teamId ?? input.team_id ?? teamId,
    created_at: input.createdAt ?? input.created_at ?? null,
    updated_at: input.updatedAt ?? input.updated_at ?? null,
    last_message_at: input.lastMessageAt ?? input.last_message_at ?? null,
    last_message_preview: input.lastMessagePreview ?? input.last_message_preview ?? null,
    mode: normalizeMode(input.mode),
    idea_id: input.ideaId ?? input.idea_id ?? null,
    has_unread: false,
  };
}

function backfillSessionPreview(entry: SessionListEntry, messages: Message[]): SessionListEntry {
  if (entry.last_message_at && entry.last_message_preview) return entry;
  const latest = messages[messages.length - 1];
  if (!latest) return entry;
  return {
    ...entry,
    last_message_at: entry.last_message_at ?? protoTimeToIso(latest.createdAt),
    last_message_preview: entry.last_message_preview ?? latest.content,
  };
}

function normalizeMode(mode: SeedSession["mode"]): SessionListEntry["mode"] {
  if (mode === "collab" || mode === "control" || mode === "solo") return mode;
  return "collab";
}

function participantActorIds(session: SeedSession, actors: NormalizedActor[]): string[] {
  const explicit =
    session.participantActorIds ??
    session.participant_actor_ids ??
    session.participants?.map((p) => {
      if (typeof p === "string") return p;
      return p.actorId ?? p.actor_id ?? p.id ?? "";
    });
  const ids = explicit?.filter(Boolean) ?? actors.map((a) => a.id);
  return [...new Set(ids)];
}

function sortRows(rows: SessionListEntry[]): SessionListEntry[] {
  return sortSessionListRows(rows);
}

function sameSessionRows(a: SessionListEntry[], b: SessionListEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, index) => {
    const other = b[index];
    return (
      row.id === other.id &&
      row.title === other.title &&
      row.team_id === other.team_id &&
      row.last_message_at === other.last_message_at &&
      row.last_message_preview === other.last_message_preview &&
      row.mode === other.mode &&
      row.idea_id === other.idea_id &&
      row.has_unread === other.has_unread
    );
  });
}

useSessionListStore.subscribe((state) => {
  if (internalMutationDepth > 0 || !isV2E2EControlActive() || !seededSessionRows) return;
  if (sameSessionRows(state.rows, seededSessionRows)) return;
  const rows = seededSessionRows;
  withInternalMutation(() => useSessionListStore.setState({
    rows,
    loading: false,
    error: null,
    hasMore: false,
    nextCursor: null,
  }));
});

function messageKindFrom(input: MessageKind | string | undefined): MessageKind {
  if (typeof input === "number") return input;
  const key = (input ?? "text").trim().toLowerCase();
  const map: Record<string, MessageKind> = {
    text: MessageKind.TEXT,
    user: MessageKind.TEXT,
    system: MessageKind.SYSTEM,
    work_event: MessageKind.WORK_EVENT,
    workevent: MessageKind.WORK_EVENT,
    agent_thinking: MessageKind.AGENT_THINKING,
    agentthinking: MessageKind.AGENT_THINKING,
    thinking: MessageKind.AGENT_THINKING,
    agent_tool_call: MessageKind.AGENT_TOOL_CALL,
    agenttoolcall: MessageKind.AGENT_TOOL_CALL,
    tool_call: MessageKind.AGENT_TOOL_CALL,
    toolcall: MessageKind.AGENT_TOOL_CALL,
    agent_tool_result: MessageKind.AGENT_TOOL_RESULT,
    agenttoolresult: MessageKind.AGENT_TOOL_RESULT,
    tool_result: MessageKind.AGENT_TOOL_RESULT,
    toolresult: MessageKind.AGENT_TOOL_RESULT,
    agent_reply: MessageKind.AGENT_REPLY,
    agentreply: MessageKind.AGENT_REPLY,
    assistant: MessageKind.AGENT_REPLY,
  };
  return map[key] ?? MessageKind.TEXT;
}

function kindToCacheString(kind: MessageKind): string {
  switch (kind) {
    case MessageKind.SYSTEM:
      return "system";
    case MessageKind.WORK_EVENT:
      return "work_event";
    case MessageKind.AGENT_THINKING:
      return "agent_thinking";
    case MessageKind.AGENT_TOOL_CALL:
      return "agent_tool_call";
    case MessageKind.AGENT_TOOL_RESULT:
      return "agent_tool_result";
    case MessageKind.AGENT_REPLY:
      return "agent_reply";
    case MessageKind.TEXT:
    default:
      return "text";
  }
}

function createdAtSeconds(value: string | number | undefined): bigint {
  if (typeof value === "number") {
    return BigInt(Math.floor(value > 10_000_000_000 ? value / 1000 : value));
  }
  if (value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return BigInt(Math.floor(parsed / 1000));
  }
  return BigInt(Math.floor(Date.now() / 1000));
}

function protoTimeToIso(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

function buildMessage(input: AppendMessageInput): Message {
  const sessionId = input.sessionId ?? input.session_id;
  if (!sessionId) throw new Error("sessionId is required");

  return createProto(MessageSchema, {
    messageId: input.messageId ?? input.message_id ?? crypto.randomUUID(),
    sessionId,
    senderActorId: input.senderActorId ?? input.sender_actor_id ?? "",
    kind: messageKindFrom(input.kind),
    content: input.content ?? "",
    createdAt: createdAtSeconds(input.createdAt),
    replyToMessageId: input.replyToMessageId ?? input.reply_to_message_id ?? "",
    mentions: input.mentions ?? [],
    model: input.model ?? "",
    metadataJson: input.metadataJson ?? input.metadata_json ?? "",
    turnId: input.turnId ?? input.turn_id ?? "",
  });
}

function deterministicFinalMessageId(sessionId: string, actorId: string, runId: string): string {
  return `e2e-final:${sessionId}:${actorId}:${runId}`;
}

function messageToCacheRow(message: Message, teamId: string): MessageRow {
  const timestamp = nowIso();
  return {
    id: message.messageId,
    teamId,
    sessionId: message.sessionId,
    turnId: message.turnId || null,
    senderActorId: message.senderActorId || null,
    replyToMessageId: message.replyToMessageId || null,
    kind: kindToCacheString(message.kind),
    content: message.content,
    metadataJson: message.metadataJson || null,
    model: message.model || null,
    mentionsJson: message.mentions.length > 0 ? JSON.stringify(message.mentions) : null,
    origin: "local-only",
    createdAt: protoTimeToIso(message.createdAt),
    updatedAt: timestamp,
    deletedAt: null,
    syncedAt: timestamp,
  };
}

function sessionToCacheRow(session: SeedSession, entry: SessionListEntry): SessionRow {
  const timestamp = nowIso();
  const createdAt = session.createdAt ?? session.created_at ?? entry.last_message_at ?? timestamp;
  const updatedAt = session.updatedAt ?? session.updated_at ?? entry.last_message_at ?? timestamp;
  return {
    id: entry.id,
    teamId: entry.team_id,
    title: entry.title,
    mode: entry.mode,
    primaryAgentId: session.primaryAgentId ?? session.primary_agent_id ?? null,
    ideaId: entry.idea_id,
    summary: null,
    lastMessagePreview: entry.last_message_preview,
    lastMessageAt: entry.last_message_at,
    createdBy: session.createdBy ?? session.created_by ?? null,
    metadataJson: null,
    createdAt,
    updatedAt,
    deletedAt: null,
    syncedAt: timestamp,
  };
}

function updateSessionPreview(sessionId: string, message: Message): void {
  const lastMessageAt = protoTimeToIso(message.createdAt);
  withInternalMutation(() => {
    useSessionListStore.setState((state) => {
      const rows = sortRows(
        state.rows.map((row) =>
          row.id === sessionId
            ? {
                ...row,
                last_message_at: lastMessageAt,
                last_message_preview: message.content,
              }
            : row,
        ),
      );
      seededSessionRows = seededSessionRows
        ? sortRows(
            seededSessionRows.map((row) =>
              row.id === sessionId
                ? {
                    ...row,
                    last_message_at: lastMessageAt,
                    last_message_preview: message.content,
                  }
                : row,
            ),
          )
        : null;
      return { rows };
    });
  });
}

function resolveTeamId(sessionId: string): string {
  return (
    useSessionListStore.getState().rows.find((row) => row.id === sessionId)?.team_id ??
    useCurrentTeamStore.getState().team?.id ??
    "e2e-team"
  );
}

function requireStreamIds(input: StreamInput): { sessionId: string; actorId: string } {
  const sessionId = input.sessionId ?? input.session_id;
  const actorId = input.actorId ?? input.actor_id;
  if (!sessionId) throw new Error("sessionId is required");
  if (!actorId) throw new Error("actorId is required");
  return { sessionId, actorId };
}

async function persistMessages(messages: Message[], teamId: string): Promise<void> {
  if (!isTauri() || messages.length === 0) return;
  await upsertMessagesBatch(messages.map((message) => messageToCacheRow(message, teamId)));
}

function installCurrentTeam(teamId: string, actors: NormalizedActor[]): void {
  const member = actors.find((actor) => actor.actorType === "member") ?? actors[0];
  useCurrentTeamStore.setState({
    team: { id: teamId, name: teamId, slug: teamId },
    currentMember: member
      ? {
          id: member.id,
          displayName: member.displayName,
          role: member.actorType === "member" ? "member" : null,
          joinedAt: member.createdAt,
        }
      : null,
    loading: false,
    error: null,
  });
}

const control: V2E2EControl = {
  seedConversation: async (input) => {
    const actors = (input.actors ?? []).map(normalizeActor);
    const baseSessionEntries = (input.sessions ?? []).map((session) => normalizeSession(session, input.teamId));
    const messagesBySession = input.messagesBySession ?? {};
    const duplicateSessionIds = baseSessionEntries.filter((entry, index) =>
      baseSessionEntries.findIndex((candidate) => candidate.id === entry.id) !== index,
    );
    if (duplicateSessionIds.length > 0) {
      throw new Error(`duplicate seeded session id: ${duplicateSessionIds[0].id}`);
    }
    if (isV2E2EControlActive()) {
      const reused = baseSessionEntries.find((entry) => seededSessionIds.has(entry.id));
      if (reused) {
        throw new Error(
          `seeded session id ${reused.id} was reused while V2 E2E control is active; use run-scoped session ids or call cleanup first`,
        );
      }
    }

    const nextMessages: Record<string, Message[]> = {};
    for (const entry of baseSessionEntries) {
      nextMessages[entry.id] = (messagesBySession[entry.id] ?? [])
        .map((message) =>
          buildMessage({
            ...message,
            sessionId: message.sessionId ?? message.session_id ?? entry.id,
            messageId: message.messageId ?? message.message_id ?? message.id,
            senderActorId: message.senderActorId ?? message.sender_actor_id,
            replyToMessageId: message.replyToMessageId ?? message.reply_to_message_id,
            metadataJson: message.metadataJson ?? message.metadata_json,
            turnId: message.turnId ?? message.turn_id,
            createdAt: message.createdAt ?? message.created_at,
          }),
        )
        .sort((a, b) => Number(a.createdAt - b.createdAt));
    }
    const sessionEntries = sortRows(
      baseSessionEntries.map((entry) => backfillSessionPreview(entry, nextMessages[entry.id] ?? [])),
    );
    seededSessionRows = sessionEntries;
    const activeSessionId = input.activeSessionId ?? sessionEntries[0]?.id ?? null;
    const warnings: string[] = [];
    if (!isTauri() && sessionEntries.length > 0) {
      warnings.push("participant cache is populated only in Tauri; non-Tauri E2E runs should not assert sidebar participant clusters");
    }
    if (isTauri()) {
      warnings.push("cleanup clears frontend E2E state only; local-cache rows are upserted, so E2E callers should use unique run/session/message ids per run");
    }

    setV2E2EControlActive(true);
    seededRunIds.add(input.runId);
    actors.forEach((actor) => seededActorIds.add(actor.id));
    sessionEntries.forEach((session) => seededSessionIds.add(session.id));

    if (input.workspacePath) {
      useWorkspaceStore.setState({
        workspacePath: input.workspacePath,
        workspaceName: workspaceNameFromPath(input.workspacePath),
        isLoadingWorkspace: false,
      });
    }

    installCurrentTeam(input.teamId, actors);
    useUIStore.setState({
      currentView: "chat",
      settingsInitialSection: null,
      defaultNavTab: "session",
      sidebarFilter: { kind: "all" },
      draftPreselectedActor: null,
      draftIdeaId: null,
    });

    useActorsStore.getState().upsertMany(
      actors.map((actor) =>
        createProto(ActorSchema, {
          actorId: actor.id,
          actorType: actorProtoType(actor.actorType),
          displayName: actor.displayName,
        }),
      ),
    );

    if (isTauri()) {
      // Point the local-cache team gate at the seeded team. installCurrentTeam
      // above only updates the frontend store; without this the Rust gate stays
      // on whatever the persisted dev login set (a real team), and every upsert
      // batch below is rejected with "team gate mismatch".
      await setLocalCacheCurrentTeam(input.teamId);
      const timestamp = nowIso();
      const actorRows: ActorRow[] = actors.map((actor) => ({
        id: actor.id,
        teamId: input.teamId,
        actorType: actor.actorType,
        displayName: actor.displayName,
        avatarUrl: actor.avatarUrl,
        memberStatus: actor.memberStatus,
        agentStatus: actor.agentStatus,
        metadataJson: null,
        createdAt: actor.createdAt,
        updatedAt: actor.updatedAt,
        deletedAt: null,
        syncedAt: timestamp,
      }));
      const entriesById = new Map(sessionEntries.map((entry) => [entry.id, entry] as const));
      const sessionRows = (input.sessions ?? []).flatMap((session) => {
        const entry = entriesById.get(session.id ?? session.sessionId ?? session.session_id ?? "");
        return entry ? [sessionToCacheRow(session, entry)] : [];
      });
      const participantRows: SessionParticipantRow[] = (input.sessions ?? []).flatMap((session) => {
        const entry = sessionEntries.find((row) => row.id === (session.id ?? session.sessionId ?? session.session_id));
        if (!entry) return [];
        return participantActorIds(session, actors).map((actorId) => ({
          id: `${entry.id}:${actorId}`,
          sessionId: entry.id,
          actorId,
          joinedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
          deletedAt: null,
          syncedAt: timestamp,
        }));
      });
      const messageRows = Object.values(nextMessages).flat().map((message) => messageToCacheRow(message, input.teamId));

      await upsertActorsBatch(actorRows);
      await upsertSessionsBatch(sessionRows);
      await upsertSessionParticipantsBatch(participantRows);
      await upsertMessagesBatch(messageRows);
    }

    withInternalMutation(() => {
      useSessionListStore.setState({
        rows: sessionEntries,
        loading: false,
        error: null,
        hasMore: false,
        nextCursor: null,
      });
    });

    useSessionStore.setState({
      messages: nextMessages,
      activeSessionId,
      currentSessionId: activeSessionId,
      isLoading: false,
      sessionError: null,
      errorSessionId: null,
      messageQueue: [],
      pendingPermissions: [],
      pendingQuestions: [],
    });

    return { runId: input.runId, warnings };
  },

  switchSession: async (input) => {
    const sessionId = typeof input === "string" ? input : input.sessionId ?? input.session_id;
    if (!sessionId) throw new Error("sessionId is required");
    useUIStore.setState({
      currentView: "chat",
      settingsInitialSection: null,
      draftPreselectedActor: null,
      sidebarFilter: { kind: "all" },
    });
    useSessionStore.setState({ activeSessionId: sessionId, currentSessionId: sessionId });
  },

  appendMessage: async (input) => {
    const message = buildMessage(input);
    const teamId = resolveTeamId(message.sessionId);
    useSessionStore.getState().appendMessage(message.sessionId, message);
    updateSessionPreview(message.sessionId, message);
    await persistMessages([message], teamId);
    return message;
  },

  emitAgentDelta: (input) => {
    const { sessionId, actorId } = requireStreamIds(input);
    const delta = input.delta ?? input.text ?? "";
    if (input.channel === "thinking") {
      useV2StreamingStore.getState().appendThinking(sessionId, actorId, delta);
    } else {
      useV2StreamingStore.getState().appendOutput(sessionId, actorId, delta);
    }
  },

  startTool: (input) => {
    const { sessionId, actorId } = requireStreamIds(input);
    useV2StreamingStore.getState().pushToolUse(sessionId, actorId, {
      toolId: input.toolId ?? input.tool_id ?? crypto.randomUUID(),
      toolName: input.toolName ?? input.tool_name ?? "tool",
      description: input.description ?? "",
      params: input.params ?? {},
      toolKind: input.toolKind ?? input.tool_kind,
    });
  },

  completeTool: (input) => {
    const { sessionId, actorId } = requireStreamIds(input);
    useV2StreamingStore.getState().completeToolUse(sessionId, actorId, {
      toolId: input.toolId ?? input.tool_id ?? "",
      success: input.success ?? true,
      summary: input.summary ?? "",
    });
  },

  setPermissionRequest: (input) => {
    const { sessionId, actorId } = requireStreamIds(input);
    useV2StreamingStore.getState().setPermissionRequest(sessionId, actorId, {
      requestId: input.requestId ?? input.request_id ?? `e2e-permission:${sessionId}:${actorId}`,
      toolName: input.toolName ?? input.tool_name ?? "tool",
      description: input.description ?? "",
      params: input.params ?? {},
    });
  },

  setAgentError: (input) => {
    const { sessionId, actorId } = requireStreamIds(input);
    useV2StreamingStore.getState().setError(
      sessionId,
      actorId,
      input.message ?? "Agent error",
      input.details ?? "",
    );
  },

  completeRun: async (input) => {
    const { sessionId, actorId } = requireStreamIds(input);
    const streamKey = `${sessionId}::${actorId}`;
    const streaming = useV2StreamingStore.getState().byKey[streamKey];
    const content = input.content ?? input.finalText ?? input.final_text ?? streaming?.outputText ?? "";
    const runId = input.runId ?? input.run_id ?? streamKey;
    const messageId = input.messageId ?? input.message_id ?? deterministicFinalMessageId(sessionId, actorId, runId);
    useV2StreamingStore.getState().finalize(sessionId, actorId, content);

    const message = buildMessage({
      sessionId,
      messageId,
      senderActorId: actorId,
      kind: MessageKind.AGENT_REPLY,
      content,
      model: input.model ?? null,
      turnId: runId,
    });
    const existing = useSessionStore
      .getState()
      .messages[sessionId]?.find((candidate) => candidate.messageId === message.messageId);
    if (existing) {
      useV2StreamingStore.getState().clearActor(sessionId, actorId, {
        includeArchives: true,
      });
      return existing;
    }
    const teamId = resolveTeamId(sessionId);
    useSessionStore.getState().appendMessage(sessionId, message);
    updateSessionPreview(sessionId, message);
    useV2StreamingStore.getState().clearActor(sessionId, actorId, {
      includeArchives: true,
    });
    await persistMessages([message], teamId);
    return message;
  },

  cleanup: () => {
    const sessionsToClear = new Set(seededSessionIds);
    const actorsToClear = new Set(seededActorIds);
    setV2E2EControlActive(false);
    seededSessionRows = null;

    withInternalMutation(() => {
      useSessionListStore.setState((state) => ({
        rows: state.rows.filter((row) => !sessionsToClear.has(row.id)),
        loading: false,
        error: null,
        hasMore: false,
        nextCursor: null,
      }));
    });
    useSessionStore.setState((state) => {
      const messages = { ...state.messages };
      for (const sessionId of sessionsToClear) delete messages[sessionId];
      return {
        messages,
        activeSessionId: null,
        currentSessionId: null,
        messageQueue: [],
        pendingPermissions: [],
        pendingQuestions: [],
        sessionError: null,
      };
    });
    useV2StreamingStore.setState((state) => {
      const byKey = { ...state.byKey };
      for (const [key, entry] of Object.entries(byKey)) {
        if (sessionsToClear.has(entry.sessionId)) delete byKey[key];
      }
      return { byKey };
    });
    useActorsStore.setState((state) => {
      const byId = { ...state.byId };
      for (const actorId of actorsToClear) delete byId[actorId];
      return { byId };
    });

    seededSessionIds.clear();
    seededActorIds.clear();
    seededRunIds.clear();
    // local-cache exposes upsert/soft-delete helpers, but no hard-delete-by-run
    // primitive. Keep cleanup scoped to frontend state and require E2E callers
    // to use unique run/session/message ids for repeatable Tauri runs.
  },
};

export function installV2E2EControl(): void {
  if (!E2E_BUILD || typeof window === "undefined") return;
  markV2E2EControlInstalled();
  window.__TEAMCLU_V2_E2E__ = control;
}
