// ── Concrete shapes for the state the session store still hosts ──

/** One choice offered by the agent's `question` tool. */
export interface QuestionOption {
  label: string;
  value?: string;
  description?: string;
}

/** One question raised by the agent's `question` tool (question.asked payload). */
export interface Question {
  id?: string;
  header?: string;
  question?: string;
  options?: QuestionOption[];
  multiple?: boolean;
}

/** A plan entry rendered in the composer plan slot (live plan or persisted). */
export interface Todo {
  id: string;
  content: string;
  /** "pending" | "in_progress" | "completed" for plans; other runtimes may add values. */
  status: string;
  /** "high" | "medium" | "low" when the runtime reports one. */
  priority?: string;
}

/** Per-session runtime status as consumed by the sidebar activity map. */
export interface SessionStatusInfo {
  /** "idle" | "busy" | "retry"; anything else is treated as running. */
  type: string;
}

/** Permission request as carried by a legacy permission.asked event. */
export interface PermissionAskedEvent {
  id: string;
  permission: string;
  sessionID?: string;
  patterns?: string[];
  always?: string[];
  alwaysAllow?: boolean;
  decision?: "pending" | "approved" | "denied" | "allowlisted";
  metadata?: Record<string, unknown>;
}

/** Structured agent-turn error rendered by SessionErrorAlert. */
interface SessionErrorEventDetail {
  name?: string;
  data?: {
    message?: string;
    statusCode?: number;
    providerID?: string;
    isRetryable?: boolean;
  };
}

export interface SessionErrorEvent {
  sessionId?: string | null;
  error?: SessionErrorEventDetail;
}

export interface PendingPermissionEntry {
  permission: PermissionAskedEvent;
  childSessionId: string | null;
  ownerSessionId?: string | null;
  sourceToolName?: string | null;
  sourceToolCallId?: string | null;
}

export interface ToolCallPermission {
  id: string;
  permission: string;
  patterns: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  decision: "pending" | "approved" | "denied" | "allowlisted";
}

export interface ToolCall {
  id: string;
  name: string;
  /** ACP ToolKind as snake_case: "read"|"edit"|"delete"|"move"|"search"|"execute"|"think"|"fetch"|"switch_mode"|"other" */
  toolKind?: string;
  /** ACP tool call status on the wire (pending|in_progress|completed|failed). */
  acpStatus?: string;
  status: "calling" | "completed" | "failed" | "waiting";
  arguments: Record<string, unknown>;
  result?: unknown;
  duration?: number;
  startTime: Date;
  /** ACP ToolCallContent blocks (text / diff / terminal). */
  content?: import("@/components/chat/tool-calls/tool-call-content").ToolCallContentBlock[];
  /** ACP ToolCallLocation follow-along paths. */
  locations?: Array<{ path: string; line?: number }>;
  rawInput?: unknown;
  rawOutput?: unknown;
  permission?: ToolCallPermission;
  // For question tool
  questions?: Question[];
  // For task tool (subagent) metadata
  metadata?: {
    title?: string;
    sessionId?: string;
    childAcpSessionId?: string;
    subagentSnapshot?: MessagePart[];
    model?: { providerID: string; modelID: string };
    summary?: Array<{
      id: string;
      tool: string;
      state: {
        status: string;
        title?: string;
      };
    }>;
  };
}

export interface PendingQuestionState {
  questionId: string; // The question.asked event ID, or a local synthetic question id
  toolCallId: string;
  messageId: string;
  questions: Question[];
  sessionId?: string; // source session ID (child or parent)
  /** Agent actor to route the answer to (runtime command topic). */
  agentActorId?: string;
  source?: "agent";
}

export interface MessagePart {
  id: string;
  type: string;
  content?: string;
  text?: string; // For reasoning type
  auto?: boolean;
  overflow?: boolean;
  completed?: boolean;
  tool?: {
    name: string;
    id: string;
    input: Record<string, unknown>;
  };
  result?: {
    type: string;
    content: string;
  };
  /** v2 ordered renderer: inline tool call card at this point in the turn. */
  toolCallId?: string;
  toolCall?: ToolCall;
}

export interface Message {
  id: string;
  sessionId: string;
  /** v2: actor_id of the message sender (member or agent). Used for
   * looking up display_name from actor_directory. Optional for v1
   * compat where messages have no sender concept. */
  senderActorId?: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Actor mentions rendered as UI-only chips before user-authored content.
   * Routing still uses the v2 envelope/metadata; these labels are not part of
   * the prompt delivered to an agent. */
  mentionActorIds?: string[];
  /** Snapshot at send time: agent actor id → delivery state for UI meta line. */
  mentionDeliverySnapshot?: Record<string, "ready" | "offline" | "stale">;
  parts: MessagePart[];
  toolCalls?: ToolCall[];
  timestamp: Date;
  isStreaming?: boolean;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  cost?: number;
  permissionRequest?: PermissionAskedEvent;
  // Model information (stored per-message)
  modelID?: string;
  providerID?: string;
  agent?: string; // Agent/skill name
  /** ACP Plan steps captured at turn end. present = show collapsed PlanCard. */
  planEntries?: PlanEntry[];
  displayKind?: "compaction" | "compaction-summary" | "synthetic";
  hidden?: boolean;
  parentID?: string;
  compaction?: {
    auto?: boolean;
    overflow?: boolean;
    completed?: boolean;
  };
  /** Outbox delivery status for outgoing messages (user-authored). Drives the
   * leading status dot in the bubble (circle / check / error). `undefined`
   * means "already delivered" — historical messages from Supabase have no
   * outbox row and shouldn't show any indicator. */
  sendStatus?: "pending" | "inFlight" | "delivered" | "failed";
  /** Mirrors `OutboxRow.attempt_count` — surfaced for click-to-retry UX. */
  sendAttempt?: number;
  /** Mirrors `OutboxRow.last_error` — shown in tooltip on failed bubble. */
  sendError?: string;
  /** User message this agent reply is responding to (quote / jump target). */
  replyToMessageId?: string | null;
  /** ACP turn correlation id when available (debug / grouping). */
  turnId?: string | null;
  /** Daemon AGENT_REPLY metadata.turn_status — e.g. user abort. */
  turnStatus?:
    | "interrupted"
    | "no_final_reply"
    | "skill_created_in_unsupported_directory"
    | null;
  /** Structured native skill violations when turnStatus is unsupported-directory. */
  nativeSkillViolations?: { slug: string; root: string; path?: string }[];
  /** Historical turn: process parts omitted until user expands collapsible. */
  processDeferred?: boolean;
  /** Lightweight process summary while {@link processDeferred} is true. */
  processMeta?: { toolCount: number; hasThinking: boolean };
  /** Locates proto rows for on-demand process hydration. */
  lazyProcessRef?: {
    sessionId: string;
    turnId: string;
    senderActorId: string;
  };
}

interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface Session {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  messageCount?: number;
  directory?: string; // Working directory for this session
  parentID?: string; // Parent session ID (for child/subagent sessions)
  isArchived?: boolean;
  archivedAt?: Date;
  ideaId?: string | null;
  /** How the session was created. 'cron' marks sessions auto-created by a
   *  scheduled task; undefined/'user' for normal sessions. */
  source?: "user" | "cron" | "gateway";
  /** For source='cron', the cron job id that created this session. */
  cronJobId?: string | null;
}

// Queued message type
export interface QueuedMessage {
  id: string;
  content: string;
  timestamp: Date;
}
