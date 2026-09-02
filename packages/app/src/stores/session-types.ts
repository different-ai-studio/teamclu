import type { StoreApi } from 'zustand';

// ── Local type stubs for the legacy agent SDK shapes ──
// Chat runtime is disabled and the consuming stores below are dead code that
// we only need to keep typechecking. Stubs are intentionally loose (`any`)
// to avoid chasing every legacy field.
export type Question = any;
export type Todo = any;
export type FileDiff = any;
export type SendMessageFilePart = any;
export type SessionStatusInfo = any;

export type PermissionAskedEvent = any;

export type TodoUpdatedEvent = any;
export type SessionDiffEvent = any;
export type SessionErrorEvent = any;

export type SessionCreatedEvent = any;
export type SessionUpdatedEvent = any;
export type ExternalMessageEvent = any;
export type SessionBusyEvent = any;
export type SessionIdleEvent = any;
export type SessionStatusEvent = any;
export type AgentSSEEvent = any;

export type MessageCreatedEvent = any;
export type MessagePartCreatedEvent = any;
export type MessagePartUpdatedEvent = any;
export type MessageCompletedEvent = any;
export type ToolExecutingEvent = any;
export type QuestionAskedEvent = any;
// ── End local stubs ──

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

export interface PlanEntry {
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

// Child session (subagent) streaming state
export interface ChildStreamingState {
  sessionId: string;
  text: string;
  reasoning: string;
  isStreaming: boolean;
}

// Queued message type
export interface QueuedMessage {
  id: string;
  content: string;
  timestamp: Date;
}

// Selected model for chat
export interface SelectedModel {
  providerID: string;
  modelID: string;
  name: string;
}

export interface SessionState {
  // State
  sessions: Session[];
  pinnedSessionIds: string[];
  currentWorkspacePath: string | null;
  activeSessionId: string | null;
  currentSessionId: string | null;
  isLoading: boolean;
  isLoadingMore: boolean; // Loading more sessions (UI pagination)
  hasMoreSessions: boolean; // Whether there are more sessions to show
  visibleSessionCount: number; // How many sessions are currently visible in sidebar
  error: string | null;
  errorSessionId: string | null;
  isConnected: boolean;

  // Selected model
  selectedModel: SelectedModel | null;

  // Streaming state — moved to streaming.ts (useStreamingStore)
  // streamingMessageId, streamingContent, childSessionStreaming are now in useStreamingStore

  // Message queue
  messageQueue: QueuedMessage[];

  // Permission requests (scoped to child session lifecycle; multiple concurrent sub-agents)
  pendingPermissions: PendingPermissionEntry[];

  // Pending questions (from question tool; multiple concurrent)
  pendingQuestions: PendingQuestionState[];
  pendingQuestionIdsBySession: Record<string, string[] | undefined>;
  /** Snapshot Q&A by toolCallId so Process cards stay populated after answer. */
  answeredQuestionsByToolCallId: Record<
    string,
    { questions: Question[]; answers: Record<string, string> }
  >;

  // Todo list (from todowrite tool)
  todos: Todo[];

  // Session diff (file changes in current session)
  sessionDiff: FileDiff[];

  // Session error
  sessionError: SessionErrorEvent | null;

  // Session status (mirrors the agent runtime's server-side session status)
  sessionStatus: SessionStatusInfo | null;
  sessionStatuses: Record<string, SessionStatusInfo | undefined>;

  // childSessionStreaming — moved to streaming.ts (useStreamingStore)

  // Inactivity warning (no SSE events for 30+ seconds during streaming)
  inactivityWarning: boolean;

  // Highlighted session IDs (newly created externally, auto-clears after 5s)
  highlightedSessionIds: string[];

  // Draft input text (preserved when navigating away from chat)
  draftInput: string;

  // Archived session viewing - separate from active session navigation
  archivedSessions: Session[];
  isLoadingArchivedSessions: boolean;
  archivedSessionError: string | null;
  viewingArchivedSessionId: string | null;
  archivedSessionMessages: Record<string, Message[]>;

  // Actions - Session management
  loadSessions: (workspacePath?: string) => Promise<void>;
  loadMoreSessions: () => Promise<void>;
  createSession: (workspacePath?: string) => Promise<Session | null>;
  setActiveSession: (id: string) => Promise<void>;
  archiveSession: (id: string) => Promise<void>;
  loadArchivedSessions: (workspacePath?: string) => Promise<void>;
  openArchivedSession: (id: string) => Promise<void>;
  closeArchivedSession: () => void;
  restoreSession: (id: string) => Promise<void>;
  updateSessionTitle: (id: string, title: string) => Promise<void>;
  toggleSessionPinned: (id: string) => void;
  resetSessions: () => void;

  // Actions - Model selection
  setSelectedModel: (model: SelectedModel | null) => void;

  // Actions - Draft input
  setDraftInput: (input: string) => void;
  clearDraftInput: () => void;

  // Actions - Message handling
  sendMessage: (content: string, agent?: string, imageParts?: SendMessageFilePart[]) => Promise<void>;
  abortSession: () => Promise<void>;
  removeFromQueue: (id: string) => void;

  // Actions - SSE event handlers
  handleMessageCreated: (event: MessageCreatedEvent) => void;
  handleMessagePartCreated: (event: MessagePartCreatedEvent) => void;
  handleMessagePartUpdated: (event: MessagePartUpdatedEvent) => void;
  handleMessageCompleted: (event: MessageCompletedEvent) => void;
  handleToolExecuting: (event: ToolExecutingEvent) => void;

  // Actions - Permission (legacy UI; v2 ACP path uses replyAcpPermission directly)
  replyPermission: (
    permissionId: string,
    decision: "allow" | "deny" | "always",
  ) => Promise<void>;

  // Actions - Question
  answerQuestion: (answers: Record<string, string>, questionId?: string) => Promise<void>;
  skipQuestion: (questionId?: string) => Promise<void>;
  setPendingQuestion: (
    question: PendingQuestionState | null,
  ) => void;
  handleQuestionAsked: (event: QuestionAskedEvent) => void;

  // Actions - Session lifecycle (SSE global events)
  handleSessionCreated: (event: SessionCreatedEvent) => void;
  handleSessionUpdated: (event: SessionUpdatedEvent) => void;
  clearHighlightedSession: (sessionId: string) => void;

  // Actions - Child session (subagent) streaming
  handleChildSessionEvent: (event: AgentSSEEvent) => void;

  // Actions - External message handling
  handleExternalMessage: (event: ExternalMessageEvent) => void;
  reloadActiveSessionMessages: () => Promise<void>;

  // Actions - Session status tracking
  handleSessionStatus: (event: SessionStatusEvent) => void;
  handleSessionBusy: (event: SessionBusyEvent) => void;
  handleSessionIdle: (event: SessionIdleEvent) => void;

  // Actions - Todo, Diff, Error
  handleTodoUpdated: (event: TodoUpdatedEvent) => void;
  handleSessionDiff: (event: SessionDiffEvent) => void;
  handleFileEdited: (file: string) => void;
  refreshSessionDiff: () => Promise<void>;
  handleSessionError: (event: SessionErrorEvent) => void;
  clearSessionError: () => void;

  // Actions - Dashboard batch loading
  dashboardLoading: boolean;
  dashboardLoadProgress: { loaded: number; total: number };
  dashboardLoadError?: string;
  loadAllSessionMessages: (workspacePath?: string) => Promise<void>;

  // Actions - Connection
  setConnected: (connected: boolean) => void;
  setError: (error: string | null, sessionId?: string | null) => void;
  /** Show a structured error alert (SessionErrorAlert) in a session's thread. */
  setSessionErrorEvent: (event: SessionErrorEvent) => void;
  setInactivityWarning: (active: boolean) => void;

  // Getters
  getActiveSession: () => Session | undefined;
  getSessionMessages: (sessionId: string) => Message[];
}

// Zustand action creator helper types
export type SessionSet = StoreApi<SessionState>['setState'];
export type SessionGet = StoreApi<SessionState>['getState'];
