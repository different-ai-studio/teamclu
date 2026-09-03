import { create } from "zustand";
import {
  daemonFinalDuplicatesTranscript,
  joinTextPartsFromParts,
  reconcileSingleSegmentDrift,
  replaceLastPostToolTextPart,
} from "@/lib/agent-reply-transcript";
import { logInterruptMsgDiag } from "@/lib/interrupt-msg-diag-core";
import {
  logStreamToolDiag,
  summarizeToolCallsForDiag,
} from "@/lib/stream-tool-diag";
import type { MessagePart, ToolCall } from "@/stores/session-types";
import type { ToolCallContentBlock } from "@/components/chat/tool-calls/tool-call-content";
import type { AcpEvent } from "@/lib/proto/amux_pb";
import { maybeBindTaskChildFromToolUpdate, isTaskToolCall } from "@/lib/teamclu/subagent-acp-binding";
import { routeSubagentAcpEvent } from "@/lib/teamclu/subagent-acp-route";
// Part/tool-call merging lives next door; see v2-stream-parts.ts.
import {
  entryParts,
  finishUnresolvedTools,
  appendOverlappingChunk,
  mergeChunk,
  appendTextPart,
  appendOutputToParts,
  appendReasoningPart,
  withCompletedTool,
  completedToolPlaceholder,
  toolCallPart,
  syncToolParts,
  reviveToolCallPart,
  mergeToolCallFromEnrichedParts,
  toolUseArguments,
  mergeToolUse,
  previewTextUpdate,
} from "./v2-stream-parts";
// Re-exported so existing import sites keep working.
export {
  finishUnresolvedTools,
  syncToolPartsForPersist,
} from "./v2-stream-parts";
export interface StreamingPlanEntry {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface StreamingPermissionRequest {
  requestId: string;
  toolName: string;
  description: string;
  params: Record<string, string>;
  /** ACP PermissionOption list from the agent (OpenCode: once / always / reject). */
  options?: Array<{ optionId: string; kind: string; name: string }>;
  /**
   * Human actor that started this agent turn (from params.requester_actor_id).
   * Empty/undefined = legacy daemon; interactive UI shown to everyone.
   */
  requesterActorId?: string;
}

export interface AgentStreamEntry {
  sessionId: string;
  actorId: string;
  outputText: string;           // accumulated output deltas, or final content after finalize
  thinkingText: string;         // accumulated thinking deltas
  parts: MessagePart[];         // ordered live render parts: text/tool-call as ACP events arrive
  toolCalls: ToolCall[];        // pushed on AcpToolUse, completed on AcpToolResult
  planEntries: StreamingPlanEntry[]; // replaced wholesale on AcpPlanUpdate
  pendingPermissionsByRequestId: Record<string, StreamingPermissionRequest>;
  errorMessage: string | null;  // set on AcpError
  errorDetails: string | null;
  lastUpdate: number;           // ms epoch
  active: boolean;              // true while streaming; false after finalize
  /** Per-turn id; archived rows copy it for precise skipArchive cleanup. */
  streamId: string;
}

export interface ArchivedEntry extends AgentStreamEntry {
  /** Stable React key for the archived bubble — `${sessionId}::${actorId}::${counter}`. */
  archiveId: string;
}

/** Last non-empty agent plan for a session — survives `clearActor` after reply persist. */
interface PersistedSessionPlan {
  actorId: string;
  planEntries: StreamingPlanEntry[];
  lastUpdate: number;
}

interface State {
  byKey: Record<string, AgentStreamEntry>;
  /** Monotonic per-session counter, bumped on every mutation that can change
   * what the chat thread renders. Lets MessageList/ChatPanel subscribe O(1)
   * instead of traversing byKey per delta. */
  revisionBySession: Record<string, number>;
  /** Prior-turn entries archived when the next turn starts. We keep these so
   * thinking + tool_calls from earlier turns stay visible in the UI — the
   * daemon doesn't persist non-AgentReply kinds, so the bubble is the only
   * place they survive. Each entry has a unique `archiveId` for React keys. */
  archived: ArchivedEntry[];
  /** Session-scoped plan snapshot for the inline Todo dock after a turn ends. */
  persistedPlansBySession: Record<string, PersistedSessionPlan>;
  /** Set when user cancels a turn; enables eager flush on the next terminal finishOnly. */
  interruptedFlushPending: Record<string, true>;
  markInterruptedFlushPending: (sessionId: string, actorId: string) => void;
  clearInterruptedFlushPending: (sessionId: string, actorId: string) => void;
  isInterruptedFlushPending: (sessionId: string, actorId: string) => boolean;
  // mergeOverlap defaults to false (plain concat) for the live-append path,
  // which is already eventId-deduped upstream. Set true only for daemon
  // resume/replay re-sends. See appendOverlappingChunk.
  appendOutput: (
    sessionId: string,
    actorId: string,
    delta: string,
    mergeOverlap?: boolean,
  ) => void;
  appendThinking: (
    sessionId: string,
    actorId: string,
    delta: string,
    mergeOverlap?: boolean,
  ) => void;
  appendOutputBatch: (
    sessionId: string,
    actorId: string,
    deltas: string[],
    mergeOverlap?: boolean,
  ) => void;
  appendThinkingBatch: (
    sessionId: string,
    actorId: string,
    deltas: string[],
    mergeOverlap?: boolean,
  ) => void;
  pushToolUse: (
    sessionId: string,
    actorId: string,
    args: {
      toolId: string;
      toolName: string;
      description: string;
      params: Record<string, string>;
      toolKind?: string;
      content?: ToolCallContentBlock[];
      locations?: Array<{ path: string; line?: number }>;
      acpStatus?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
    },
  ) => void;
  completeToolUse: (
    sessionId: string,
    actorId: string,
    args: {
      toolId: string;
      success: boolean;
      summary: string;
      content?: ToolCallContentBlock[];
      rawOutput?: unknown;
    },
  ) => void;
  setPlan: (sessionId: string, actorId: string, entries: StreamingPlanEntry[]) => void;
  setError: (sessionId: string, actorId: string, message: string, details: string) => void;
  setPermissionRequest: (
    sessionId: string,
    actorId: string,
    req: StreamingPermissionRequest,
  ) => void;
  clearPermissionRequest: (
    sessionId: string,
    actorId: string,
    requestId: string,
  ) => void;
  replaceParts: (sessionId: string, actorId: string, parts: MessagePart[]) => void;
  ingestReplyPreview: (sessionId: string, actorId: string, text: string) => void;
  finalize: (sessionId: string, actorId: string, finalText?: string) => void;
  finishSessionActor: (
    sessionId: string,
    actorId: string,
    opts?: { reason?: string },
  ) => void;
  /** Re-open live rendering after statusChange marked the turn inactive too early. */
  markActorStreamActive: (sessionId: string, actorId: string) => void;
  /** Empty active stream for statusChange ACTIVE — shows planning placeholder in UI. */
  beginPlanningPlaceholder: (sessionId: string, actorId: string) => void;
  /** Drop live byKey; archive tools/thinking only when parts_json did not persist them. */
  releaseActorAfterPersist: (
    sessionId: string,
    actorId: string,
    opts?: { persistedPartsJson?: string; persistedSourceStreamId?: string },
  ) => void;
  /** Drop live byKey without archiving — caller already snapshot parts for persist. */
  detachLiveStreamForPersist: (
    sessionId: string,
    actorId: string,
    streamId: string,
  ) => void;
  clearActor: (
    sessionId: string,
    actorId: string,
    opts?: { includeArchives?: boolean },
  ) => void;
  clearSession: (sessionId: string) => void;
  /** Nested subagent streams keyed by parent task toolCall.id */
  subagentByToolId: Record<string, AgentStreamEntry>;
  /** Child ACP session id → parent task toolCall.id */
  childAcpSessionToToolId: Record<string, string>;
  /** Events that arrived before task metadata binding */
  pendingSubagentEvents: Record<string, AcpEvent[]>;
  /** Turn-scoped subagent replay after live slice ends */
  archivedSubagentByToolId: Record<string, AgentStreamEntry>;
  bindChildAcpSession: (
    sessionId: string,
    actorId: string,
    parentToolId: string,
    childAcpSessionId: string,
  ) => void;
  bufferPendingSubagentEvent: (childAcpSessionId: string, acpEvent: AcpEvent) => void;
  subAppendOutput: (
    parentToolId: string,
    sessionId: string,
    actorId: string,
    delta: string,
  ) => void;
  subAppendThinking: (
    parentToolId: string,
    sessionId: string,
    actorId: string,
    delta: string,
  ) => void;
  subPushToolUse: (
    parentToolId: string,
    sessionId: string,
    actorId: string,
    args: {
      toolId: string;
      toolName: string;
      description: string;
      params: Record<string, string>;
      toolKind?: string;
      content?: ToolCallContentBlock[];
      locations?: Array<{ path: string; line?: number }>;
      acpStatus?: string;
      rawInput?: unknown;
    },
  ) => void;
  subCompleteToolUse: (
    parentToolId: string,
    sessionId: string,
    actorId: string,
    args: {
      toolId: string;
      success: boolean;
      summary: string;
      content?: ToolCallContentBlock[];
      rawOutput?: unknown;
    },
  ) => void;
  subSetError: (
    parentToolId: string,
    sessionId: string,
    actorId: string,
    message: string,
    details: string,
  ) => void;
  subMarkActive: (parentToolId: string, sessionId: string, actorId: string) => void;
  subFinish: (parentToolId: string) => void;
  archiveSubagentsForParent: (sessionId: string, actorId: string) => void;
  clearSubagentsForSession: (sessionId: string) => void;
  /** Drop error-only streams and strip error banners once a new turn starts. */
  clearStaleStreamErrors: (sessionId: string, actorId?: string) => void;
}

function k(sessionId: string, actorId: string): string {
  return `${sessionId}::${actorId}`;
}

function emptyEntry(sessionId: string, actorId: string): AgentStreamEntry {
  return {
    sessionId,
    actorId,
    outputText: "",
    thinkingText: "",
    parts: [],
    toolCalls: [],
    planEntries: [],
    pendingPermissionsByRequestId: {},
    errorMessage: null,
    errorDetails: null,
    lastUpdate: Date.now(),
    active: true,
    streamId: nextStreamId(sessionId, actorId),
  };
}

let archiveCounter = 0;
let streamCounter = 0;

function nextStreamId(sessionId: string, actorId: string): string {
  streamCounter += 1;
  return `${sessionId}::${actorId}::stream-${streamCounter}`;
}

function persistSessionPlan(
  persisted: Record<string, PersistedSessionPlan>,
  sessionId: string,
  actorId: string,
  entries: StreamingPlanEntry[],
): Record<string, PersistedSessionPlan> {
  if (entries.length === 0) return persisted;
  return {
    ...persisted,
    [sessionId]: {
      actorId,
      planEntries: entries,
      lastUpdate: Date.now(),
    },
  };
}


/** True when the stream has thinking, output, or tools — excluding error banners. */
function streamEntryHasNonErrorContent(entry: AgentStreamEntry): boolean {
  if (entry.thinkingText.length > 0 || entry.outputText.length > 0) return true;
  if (entry.toolCalls.length > 0) return true;
  return entryParts(entry).some(
    (part) =>
      (part.type === "reasoning" && Boolean(part.text || part.content)) ||
      (part.type === "text" && Boolean(part.text || part.content)) ||
      (part.type === "tool-call" && Boolean(part.toolCall)),
  );
}

/** True when the stream already has thinking, output, tools, or errors to render. */
export function streamEntryHasVisibleContent(entry: AgentStreamEntry): boolean {
  if (entry.errorMessage) return true;
  return streamEntryHasNonErrorContent(entry);
}

/** Error-only turns have no transcript artifacts worth keeping after a retry. */
export function isErrorOnlyStreamEntry(entry: AgentStreamEntry): boolean {
  return Boolean(entry.errorMessage) && !streamEntryHasNonErrorContent(entry);
}

function streamEntryMatchesScope(
  entry: AgentStreamEntry,
  sessionId: string,
  actorId?: string,
): boolean {
  if (entry.sessionId !== sessionId) return false;
  if (actorId && entry.actorId !== actorId) return false;
  return true;
}

function stripStreamError<T extends AgentStreamEntry>(entry: T): T | null {
  if (!entry.errorMessage) return entry;
  if (isErrorOnlyStreamEntry(entry)) return null;
  return { ...entry, errorMessage: null, errorDetails: null };
}

/** True when persisted parts_json already carries tool/thinking for ChatMessage. */
export function persistedPartsCoverLiveArtifacts(partsJson: string | undefined): boolean {
  if (!partsJson?.trim()) return false;
  try {
    const parts = JSON.parse(partsJson) as MessagePart[];
    if (!Array.isArray(parts)) return false;
    return parts.some(
      (part) =>
        (part.type === "tool-call" && Boolean(part.toolCall)) ||
        (part.type === "reasoning" && Boolean(part.text || part.content)),
    );
  } catch {
    return false;
  }
}

/** Pending UI revision bumps, coalesced to one store notify per animation frame
 *  so high-rate token deltas do not re-render ChatPanel every chunk. Store
 *  fields (outputText / parts) still update immediately in the caller’s set(). */
const pendingRevisionCounts = new Map<string, number>();

/** Upper bound on how long a coalesced bump may sit unflushed. */
const REVISION_FLUSH_FALLBACK_MS = 100;

let revisionFrameHandle: number | null = null;
let revisionTimerHandle: ReturnType<typeof setTimeout> | null = null;
let bumpDepth = 0;

function clearScheduledRevisionFlush(): void {
  if (revisionFrameHandle != null) {
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(revisionFrameHandle);
    }
    revisionFrameHandle = null;
  }
  if (revisionTimerHandle != null) {
    clearTimeout(revisionTimerHandle);
    revisionTimerHandle = null;
  }
}

/**
 * rAF keeps bumps frame-aligned while the webview renders, but it stops firing
 * entirely once the window is occluded or backgrounded — which would freeze a
 * live stream mid-output and then dump everything at once on return. A timer
 * races it so the flush never depends on a frame being painted.
 */
function scheduleRevisionFlush(): void {
  if (revisionFrameHandle != null || revisionTimerHandle != null) return;
  if (typeof requestAnimationFrame === "function") {
    revisionFrameHandle = requestAnimationFrame(() => {
      revisionFrameHandle = null;
      flushPendingSessionRevisions();
    });
  }
  revisionTimerHandle = setTimeout(() => {
    revisionTimerHandle = null;
    flushPendingSessionRevisions();
  }, REVISION_FLUSH_FALLBACK_MS);
}

type RevisionFlushTarget = {
  setState: (partial: { revisionBySession: Record<string, number> }) => void;
  getState: () => { revisionBySession: Record<string, number> };
};

/** Bound after the store is created — avoids TDZ when flush runs. */
let revisionFlushTarget: RevisionFlushTarget | null = null;

function flushPendingSessionRevisions(): void {
  // A scheduler that runs its callback synchronously would land us here while
  // the caller's set() is still being assembled — and that set() writes the
  // pre-bump revisionBySession, silently reverting whatever we flush. Leave the
  // counts pending; the fallback timer picks them up outside the bump.
  if (bumpDepth > 0) return;
  clearScheduledRevisionFlush();
  if (pendingRevisionCounts.size === 0 || !revisionFlushTarget) return;
  const counts = new Map(pendingRevisionCounts);
  pendingRevisionCounts.clear();
  const state = revisionFlushTarget.getState();
  let next = state.revisionBySession;
  for (const [sessionId, count] of counts) {
    if (count <= 0) continue;
    next = {
      ...next,
      [sessionId]: (next[sessionId] ?? 0) + count,
    };
  }
  if (next !== state.revisionBySession) {
    revisionFlushTarget.setState({ revisionBySession: next });
  }
}

/** Test helper: apply coalesced revision bumps synchronously. */
export function flushPendingSessionRevisionsForTests(): void {
  flushPendingSessionRevisions();
}

/**
 * Schedule a React-facing revision bump. Returns the *current* revisions map
 * unchanged so the caller's set() does not notify revision subscribers until
 * the coalesced flush runs.
 */
function bumpRevision(
  revisions: Record<string, number>,
  sessionId: string,
): Record<string, number> {
  pendingRevisionCounts.set(
    sessionId,
    (pendingRevisionCounts.get(sessionId) ?? 0) + 1,
  );
  bumpDepth += 1;
  try {
    scheduleRevisionFlush();
  } finally {
    bumpDepth -= 1;
  }
  return revisions;
}

// Coming back to an occluded window should not wait out the fallback timer.
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) flushPendingSessionRevisions();
  });
}


/** Returned by mutation prep: the entry to mutate AND any prior-turn entry
 * that should be archived in the same set() call. */
interface MutationPrep {
  entry: AgentStreamEntry;
  toArchive: ArchivedEntry | null;
}

/** Get the entry to mutate. If a previous-turn entry exists but is inactive
 * (finalized), capture it for archival and start a fresh entry for the new
 * turn — keeps prior turns' thinking + tool_calls visible in the UI. */
function prepareSubagentMutation(
  state: State,
  parentToolId: string,
  sessionId: string,
  actorId: string,
): AgentStreamEntry {
  const existing = state.subagentByToolId[parentToolId];
  if (existing) return existing;
  return {
    ...emptyEntry(sessionId, actorId),
    streamId: `${parentToolId}::subagent`,
  };
}

function pruneChildSessionMap(
  childMap: Record<string, string>,
  parentToolId: string,
): Record<string, string> {
  const next = { ...childMap };
  for (const [childSid, toolId] of Object.entries(next)) {
    if (toolId === parentToolId) delete next[childSid];
  }
  return next;
}

function prunePendingSubagentEvents(
  pending: Record<string, AcpEvent[]>,
  childMap: Record<string, string>,
): Record<string, AcpEvent[]> {
  const next: Record<string, AcpEvent[]> = {};
  for (const [childSid, events] of Object.entries(pending)) {
    if (childMap[childSid]) next[childSid] = events;
  }
  return next;
}

function maybeBindTaskChildFromRawOutput(
  get: () => State,
  sessionId: string,
  actorId: string,
  toolId: string,
  toolName: string,
  rawOutput: unknown,
  rawInput?: unknown,
): void {
  maybeBindTaskChildFromToolUpdate(
    get,
    sessionId,
    actorId,
    toolId,
    toolName,
    rawOutput,
    rawInput,
  );
}

function finishTaskSubagentOnComplete(
  get: () => State,
  set: (partial: Partial<State> | ((state: State) => Partial<State>)) => void,
  toolCall: ToolCall | undefined,
  toolId: string,
): void {
  if (!toolCall || !isTaskToolCall(toolCall)) return;
  get().subFinish(toolId);
  const state = get();
  const childAcpSessionToToolId = pruneChildSessionMap(
    state.childAcpSessionToToolId,
    toolId,
  );
  set({
    childAcpSessionToToolId,
    pendingSubagentEvents: prunePendingSubagentEvents(
      state.pendingSubagentEvents,
      childAcpSessionToToolId,
    ),
  });
}

/** Get the entry to mutate. If a previous-turn entry exists but is inactive
 * (finalized), capture it for archival and start a fresh entry for the new
 * turn — keeps prior turns' thinking + tool_calls visible in the UI. */
function prepareMutation(state: State, sessionId: string, actorId: string): MutationPrep {
  const key = k(sessionId, actorId);
  const existing = state.byKey[key];
  if (!existing) return { entry: emptyEntry(sessionId, actorId), toArchive: null };
  if (existing.active) return { entry: existing, toArchive: null };
  archiveCounter += 1;
  const archived: ArchivedEntry = {
    ...existing,
    archiveId: `${sessionId}::${actorId}::${archiveCounter}`,
  };
  return { entry: emptyEntry(sessionId, actorId), toArchive: archived };
}

export const useV2StreamingStore = create<State>((set, get) => ({
  byKey: {},
  revisionBySession: {},
  archived: [],
  persistedPlansBySession: {},
  interruptedFlushPending: {},
  subagentByToolId: {},
  childAcpSessionToToolId: {},
  pendingSubagentEvents: {},
  archivedSubagentByToolId: {},

  markInterruptedFlushPending: (sessionId, actorId) => {
    const key = k(sessionId, actorId);
    if (get().interruptedFlushPending[key]) return;
    set({
      interruptedFlushPending: { ...get().interruptedFlushPending, [key]: true },
    });
  },

  clearInterruptedFlushPending: (sessionId, actorId) => {
    const key = k(sessionId, actorId);
    if (!get().interruptedFlushPending[key]) return;
    const next = { ...get().interruptedFlushPending };
    delete next[key];
    set({ interruptedFlushPending: next });
  },

  isInterruptedFlushPending: (sessionId, actorId) =>
    Boolean(get().interruptedFlushPending[k(sessionId, actorId)]),

  appendOutput: (sessionId, actorId, delta, mergeOverlap = false) => {
    if (!delta) return;
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          outputText: mergeChunk(entry.outputText, delta, mergeOverlap),
          parts: appendOutputToParts(entryParts(entry), delta, mergeOverlap),
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  appendThinking: (sessionId, actorId, delta, mergeOverlap = false) => {
    if (!delta) return;
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          thinkingText: mergeChunk(entry.thinkingText, delta, mergeOverlap),
          parts: appendReasoningPart(entryParts(entry), delta, mergeOverlap),
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  appendOutputBatch: (sessionId, actorId, deltas, mergeOverlap = false) => {
    if (deltas.length === 0) return;
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    let outputText = entry.outputText;
    let parts = entryParts(entry);
    let changed = false;
    for (const delta of deltas) {
      if (!delta) continue;
      outputText = mergeChunk(outputText, delta, mergeOverlap);
      parts = appendOutputToParts(parts, delta, mergeOverlap);
      changed = true;
    }
    if (!changed) return;
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          outputText,
          parts,
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  appendThinkingBatch: (sessionId, actorId, deltas, mergeOverlap = false) => {
    if (deltas.length === 0) return;
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    let thinkingText = entry.thinkingText;
    let parts = entryParts(entry);
    let changed = false;
    for (const delta of deltas) {
      if (!delta) continue;
      thinkingText = mergeChunk(thinkingText, delta, mergeOverlap);
      parts = appendReasoningPart(parts, delta, mergeOverlap);
      changed = true;
    }
    if (!changed) return;
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          thinkingText,
          parts,
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  pushToolUse: (sessionId, actorId, { toolId, toolName, description, params, toolKind, content, locations, acpStatus, rawInput, rawOutput }) => {
    if (!toolId) return;
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    if (entry.toolCalls.some((tc) => tc.id === toolId)) {
      const toolCalls = entry.toolCalls.map((tc) =>
        tc.id === toolId
          ? mergeToolUse(tc, {
              toolName,
              description,
              params,
              toolKind,
              content,
              locations,
              acpStatus,
              rawInput,
            })
          : tc,
      );
      set({
        byKey: {
          ...state.byKey,
          [k(sessionId, actorId)]: {
            ...entry,
            toolCalls,
            parts: syncToolParts(entryParts(entry), toolCalls),
            lastUpdate: Date.now(),
            active: true,
          },
        },
        archived: toArchive ? [...state.archived, toArchive] : state.archived,
        revisionBySession: bumpRevision(state.revisionBySession, sessionId),
      });
      maybeBindTaskChildFromRawOutput(
        get,
        sessionId,
        actorId,
        toolId,
        toolName,
        rawOutput,
        rawInput,
      );
      return;
    }
    const newToolCall: ToolCall = {
      id: toolId,
      name: toolName || "unknown",
      toolKind: toolKind || undefined,
      acpStatus,
      content,
      locations,
      rawInput,
      status: "calling",
      arguments: toolUseArguments(params, description),
      startTime: new Date(),
    };
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          toolCalls: [...entry.toolCalls, newToolCall],
          parts: [
            ...entryParts(entry),
            {
              id: `stream:tool:${toolId}`,
              type: "tool-call",
              toolCallId: toolId,
              toolCall: newToolCall,
            },
          ],
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
    maybeBindTaskChildFromRawOutput(
      get,
      sessionId,
      actorId,
      toolId,
      toolName,
      rawOutput,
      rawInput,
    );
  },

  completeToolUse: (sessionId, actorId, { toolId, success, summary, content, rawOutput }) => {
    if (!toolId) return;
    const key = k(sessionId, actorId);
    const state = get();
    const existing = state.byKey[key];
    const matchedTool = existing?.toolCalls.find((tc) => tc.id === toolId);
    maybeBindTaskChildFromRawOutput(
      get,
      sessionId,
      actorId,
      toolId,
      matchedTool?.name ?? "",
      rawOutput,
      matchedTool?.rawInput,
    );
    const before = summarizeToolCallsForDiag(existing?.toolCalls);
    const fallbackToolCall = completedToolPlaceholder(toolId, success, summary);

    const applyCompletedTool = (
      entry: AgentStreamEntry,
      hasToolCall: boolean,
    ): { toolCalls: ToolCall[]; parts: MessagePart[] } => {
      const updated = hasToolCall
        ? withCompletedTool(entry.toolCalls, toolId, success, summary, content, rawOutput)
        : [...entry.toolCalls, fallbackToolCall];
      const parts = hasToolCall
        ? syncToolParts(entryParts(entry), updated)
        : [...entryParts(entry), toolCallPart(fallbackToolCall)];
      return { toolCalls: updated, parts };
    };

    if (existing?.toolCalls.some((tc) => tc.id === toolId)) {
      const { toolCalls, parts } = applyCompletedTool(existing, true);
      const completedTool = toolCalls.find((tc) => tc.id === toolId);
      set({
        byKey: {
          ...state.byKey,
          [key]: {
            ...existing,
            toolCalls,
            parts,
            lastUpdate: Date.now(),
          },
        },
        revisionBySession: bumpRevision(state.revisionBySession, sessionId),
      });
      finishTaskSubagentOnComplete(get, set, completedTool, toolId);
      logStreamToolDiag("completeToolUse", {
        sessionId,
        actorId,
        toolId,
        success,
        hadEntry: true,
        active: existing.active,
        matchedExistingTool: true,
        matchedArchived: false,
        before,
        after: summarizeToolCallsForDiag(toolCalls),
      });
      return;
    }

    let archivedIndex = -1;
    for (let i = state.archived.length - 1; i >= 0; i--) {
      const entry = state.archived[i];
      if (
        entry.sessionId === sessionId &&
        entry.actorId === actorId &&
        entry.toolCalls.some((tc) => tc.id === toolId)
      ) {
        archivedIndex = i;
        break;
      }
    }
    if (archivedIndex >= 0) {
      const archivedEntry = state.archived[archivedIndex];
      const { toolCalls, parts } = applyCompletedTool(archivedEntry, true);
      const archived = [...state.archived];
      archived[archivedIndex] = {
        ...archivedEntry,
        toolCalls,
        parts,
      };
      set({
        archived,
        revisionBySession: bumpRevision(state.revisionBySession, sessionId),
      });
      const completedTool = toolCalls.find((tc) => tc.id === toolId);
      finishTaskSubagentOnComplete(get, set, completedTool, toolId);
      logInterruptMsgDiag("stream.completeToolUse.archived", {
        sessionId,
        actorId,
        toolId,
        success,
        archiveId: archivedEntry.archiveId,
        streamId: archivedEntry.streamId,
        before: summarizeToolCallsForDiag(archivedEntry.toolCalls),
        after: summarizeToolCallsForDiag(toolCalls),
      });
      logStreamToolDiag("completeToolUse", {
        sessionId,
        actorId,
        toolId,
        success,
        hadEntry: Boolean(existing),
        active: existing?.active ?? false,
        matchedExistingTool: false,
        matchedArchived: true,
        before: summarizeToolCallsForDiag(archivedEntry.toolCalls),
        after: summarizeToolCallsForDiag(toolCalls),
      });
      return;
    }

    if (!existing) {
      // Do not spawn an active live stream for orphan tool results (e.g. after
      // idle flush deleted byKey). Late results patch the persisted message
      // via patchPersistedToolResult — creating active:true here causes the
      // Unknown / stuck "Replying" dock.
      logStreamToolDiag("completeToolUse", {
        sessionId,
        actorId,
        toolId,
        success,
        hadEntry: false,
        matchedExistingTool: false,
        matchedArchived: false,
        droppedOrphan: true,
        before,
        after: [],
      });
      return;
    }

    const { toolCalls, parts } = applyCompletedTool(existing, false);
    const completedTool = toolCalls.find((tc) => tc.id === toolId);
    set({
      byKey: {
        ...state.byKey,
        [key]: {
          ...existing,
          toolCalls,
          parts,
          lastUpdate: Date.now(),
        },
      },
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
    finishTaskSubagentOnComplete(get, set, completedTool, toolId);
    logStreamToolDiag("completeToolUse", {
      sessionId,
      actorId,
      toolId,
      success,
      hadEntry: true,
      active: existing.active,
      matchedExistingTool: false,
      matchedArchived: false,
      before,
      after: summarizeToolCallsForDiag(toolCalls),
    });
  },

  setPlan: (sessionId, actorId, entries) => {
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    // Some runtimes emit an empty plan update at turn completion.
    // Keep the last non-empty plan so the inline Todo dock does not flash
    // away right after the final reply lands.
    const nextEntries =
      entries.length > 0
        ? entries
        : entry.planEntries.length > 0
          ? entry.planEntries
          : entries;
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          planEntries: nextEntries,
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
      persistedPlansBySession: persistSessionPlan(
        state.persistedPlansBySession,
        sessionId,
        actorId,
        nextEntries,
      ),
    });
  },

  setError: (sessionId, actorId, message, details) => {
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          errorMessage: message,
          errorDetails: details,
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  setPermissionRequest: (sessionId, actorId, req) => {
    const requestId = req.requestId?.trim();
    if (!requestId) return;
    console.info("[notify-diag] v2-stream:setPermissionRequest", {
      sessionId,
      actorId,
      requestId,
      toolName: req.toolName ?? null,
    });
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          pendingPermissionsByRequestId: {
            ...entry.pendingPermissionsByRequestId,
            [requestId]: req,
          },
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  clearPermissionRequest: (sessionId, actorId, requestId) => {
    const trimmed = requestId.trim();
    if (!trimmed) return;
    const key = k(sessionId, actorId);
    const state = get();
    const existing = state.byKey[key];
    if (!existing?.pendingPermissionsByRequestId[trimmed]) return;
    const pendingPermissionsByRequestId = {
      ...existing.pendingPermissionsByRequestId,
    };
    delete pendingPermissionsByRequestId[trimmed];
    set({
      byKey: {
        ...state.byKey,
        [key]: { ...existing, pendingPermissionsByRequestId },
      },
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  replaceParts: (sessionId, actorId, parts) => {
    const key = k(sessionId, actorId);
    const state = get();
    const existing = state.byKey[key];
    if (!existing) return;
    const revivedParts = parts.map(reviveToolCallPart);
    const enrichedToolCalls = revivedParts
      .filter((part) => part.type === "tool-call" && part.toolCall)
      .map((part) => part.toolCall!);
    const enrichedById = new Map(enrichedToolCalls.map((tc) => [tc.id, tc]));
    const mergedToolCalls = [
      ...existing.toolCalls.map((tc) => {
        const enriched = enrichedById.get(tc.id);
        if (!enriched) return tc;
        return mergeToolCallFromEnrichedParts(tc, enriched);
      }),
      ...enrichedToolCalls.filter(
        (tc) => !existing.toolCalls.some((existingTc) => existingTc.id === tc.id),
      ),
    ];
    const syncedParts = syncToolParts(revivedParts, mergedToolCalls);
    logStreamToolDiag("replaceParts", {
      sessionId,
      actorId,
      toolCalls: summarizeToolCallsForDiag(mergedToolCalls),
    });
    set({
      byKey: {
        ...state.byKey,
        [key]: {
          ...existing,
          parts: syncedParts,
          toolCalls: mergedToolCalls,
          lastUpdate: Date.now(),
        },
      },
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  ingestReplyPreview: (sessionId, actorId, text) => {
    if (!text) return;
    const state = get();
    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    const preview = previewTextUpdate(entry, text);
    set({
      byKey: {
        ...state.byKey,
        [k(sessionId, actorId)]: {
          ...entry,
          outputText: preview.outputText,
          parts: preview.parts,
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived: toArchive ? [...state.archived, toArchive] : state.archived,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  /** Mark a streaming turn inactive. Live parts[] are owned by acp.event only;
   * daemon finalText may reconcile single-segment drift but must not rewrite a
   * multi-segment transcript from cumulative message.created bodies. */
  finalize: (sessionId, actorId, finalText) => {
    const key = k(sessionId, actorId);
    const state = get();
    const existing = state.byKey[key];
    if (!existing) {
      set({
        byKey: {
          ...state.byKey,
          [key]: {
            ...emptyEntry(sessionId, actorId),
            outputText: finalText ?? "",
            parts: finalText ? appendTextPart([], finalText) : [],
            active: false,
          },
        },
        revisionBySession: bumpRevision(state.revisionBySession, sessionId),
      });
      return;
    }

    let parts = entryParts(existing);
    const trimmedFinal = finalText?.trim() ?? "";
    const hasTools = parts.some((part) => part.type === "tool-call");
    const textPartCount = parts.filter(
      (part) => part.type === "text" && Boolean(part.text || part.content),
    ).length;

    if (!trimmedFinal) {
      set({
        byKey: {
          ...state.byKey,
          [key]: {
            ...existing,
            outputText: joinTextPartsFromParts(parts) || existing.outputText,
            parts,
            lastUpdate: Date.now(),
            active: false,
          },
        },
        revisionBySession: bumpRevision(state.revisionBySession, sessionId),
      });
      return;
    }

    if (trimmedFinal) {
      if (!hasTools && textPartCount <= 1) {
        const preview = previewTextUpdate(existing, trimmedFinal);
        parts = preview.parts;
      } else if (!daemonFinalDuplicatesTranscript(parts, trimmedFinal)) {
        // When the daemon final duplicates the transcript, keep parts as-is.
        if (hasTools) {
          parts = replaceLastPostToolTextPart(parts, trimmedFinal);
        } else {
          parts = reconcileSingleSegmentDrift(parts, trimmedFinal);
        }
      }
    }

    const outputText = joinTextPartsFromParts(parts) || trimmedFinal || existing.outputText;
    set({
      byKey: {
        ...state.byKey,
        [key]: {
          ...existing,
          outputText,
          parts,
          lastUpdate: Date.now(),
          active: false,
        },
      },
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  finishSessionActor: (sessionId, actorId, opts) => {
    const key = k(sessionId, actorId);
    const state = get();
    const existing = state.byKey[key];
    if (!existing) {
      logStreamToolDiag("finishSessionActor.skip", {
        sessionId,
        actorId,
        reason: opts?.reason ?? "unknown",
        hadEntry: false,
      });
      return;
    }
    const before = summarizeToolCallsForDiag(existing.toolCalls);
    const toolCalls = finishUnresolvedTools(existing.toolCalls);
    set({
      byKey: {
        ...state.byKey,
        [key]: {
          ...existing,
          toolCalls,
          parts: syncToolParts(entryParts(existing), toolCalls),
          lastUpdate: Date.now(),
          active: false,
        },
      },
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
    logStreamToolDiag("finishSessionActor", {
      sessionId,
      actorId,
      reason: opts?.reason ?? "unknown",
      hadEntry: true,
      before,
      after: summarizeToolCallsForDiag(toolCalls),
    });
    get().archiveSubagentsForParent(sessionId, actorId);
  },

  markActorStreamActive: (sessionId, actorId) => {
    const state = get();
    const key = k(sessionId, actorId);
    const existing = state.byKey[key];
    if (!existing || existing.active) return;
    set({
      byKey: {
        ...state.byKey,
        [key]: {
          ...existing,
          active: true,
          lastUpdate: Date.now(),
        },
      },
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  beginPlanningPlaceholder: (sessionId, actorId) => {
    get().clearStaleStreamErrors(sessionId, actorId);
    const state = get();
    const key = k(sessionId, actorId);
    const existing = state.byKey[key];
    if (existing?.active && streamEntryHasVisibleContent(existing)) {
      logInterruptMsgDiag("stream.beginPlanning.skip", {
        sessionId,
        actorId,
        streamId: existing.streamId,
        reason: "active-with-content",
      });
      return;
    }

    const { entry, toArchive } = prepareMutation(state, sessionId, actorId);
    logInterruptMsgDiag("stream.beginPlanning", {
      sessionId,
      actorId,
      archived: Boolean(toArchive),
      archivedStreamId: toArchive?.streamId ?? null,
      archivedToolCalls: summarizeToolCallsForDiag(toArchive?.toolCalls),
      nextStreamId: entry.streamId,
      archivedCountBefore: state.archived.length,
    });
    const interruptedFlushPending = { ...state.interruptedFlushPending };
    delete interruptedFlushPending[key];
    set({
      byKey: {
        ...state.byKey,
        [key]: {
          ...entry,
          outputText: "",
          thinkingText: "",
          parts: [],
          toolCalls: [],
          planEntries: entry.planEntries,
          pendingPermissionsByRequestId: {},
          errorMessage: null,
          errorDetails: null,
          lastUpdate: Date.now(),
          active: true,
        },
      },
      archived:
        toArchive && !isErrorOnlyStreamEntry(toArchive)
          ? [...state.archived, toArchive]
          : state.archived,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
      interruptedFlushPending,
    });
  },

  clearStaleStreamErrors: (sessionId, actorId) => {
    const state = get();
    let changed = false;

    const nextByKey = { ...state.byKey };
    for (const [key, entry] of Object.entries(state.byKey)) {
      if (!streamEntryMatchesScope(entry, sessionId, actorId)) continue;
      if (!entry.errorMessage) continue;
      const next = stripStreamError(entry);
      if (next === null) {
        delete nextByKey[key];
        changed = true;
      } else if (next !== entry) {
        nextByKey[key] = next;
        changed = true;
      }
    }

    const nextArchived = state.archived.flatMap((entry) => {
      if (!streamEntryMatchesScope(entry, sessionId, actorId)) return [entry];
      if (!entry.errorMessage) return [entry];
      const next = stripStreamError(entry);
      if (next === null) {
        changed = true;
        return [];
      }
      if (next !== entry) {
        changed = true;
        return [next];
      }
      return [entry];
    });

    if (!changed) return;
    set({
      byKey: nextByKey,
      archived: nextArchived,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  releaseActorAfterPersist: (sessionId, actorId, opts) => {
    const state = get();
    const key = k(sessionId, actorId);
    const existing = state.byKey[key];
    const next = { ...state.byKey };
    delete next[key];

    const skipArchive = persistedPartsCoverLiveArtifacts(opts?.persistedPartsJson);
    logInterruptMsgDiag("stream.releaseAfterPersist", {
      sessionId,
      actorId,
      skipArchive,
      hadByKeyEntry: Boolean(existing),
      streamId: existing?.streamId ?? null,
      persistedSourceStreamId: opts?.persistedSourceStreamId ?? null,
      partsJsonLength: opts?.persistedPartsJson?.length ?? 0,
      archivedCountBefore: state.archived.length,
    });
    let archived = state.archived;
    const persistedSourceStreamId = opts?.persistedSourceStreamId?.trim();
    if (skipArchive && (existing || persistedSourceStreamId)) {
      // Remove stale archived bubbles for the flushed turn. After
      // beginPlanningPlaceholder the live byKey entry is a new stream, so we
      // must also match the snapshot streamId from the interrupted turn.
      archived = archived.filter(
        (entry) =>
          !(
            entry.sessionId === sessionId &&
            entry.actorId === actorId &&
            ((existing && entry.streamId === existing.streamId) ||
              (persistedSourceStreamId &&
                entry.streamId === persistedSourceStreamId))
          ),
      );
    }
    if (
      !skipArchive &&
      existing &&
      (existing.outputText ||
        existing.thinkingText ||
        entryParts(existing).length > 0 ||
        existing.toolCalls.length > 0)
    ) {
      const before = summarizeToolCallsForDiag(existing.toolCalls);
      const toolCalls = finishUnresolvedTools(existing.toolCalls);
      logStreamToolDiag("releaseActorAfterPersist.archive", {
        sessionId,
        actorId,
        streamId: existing.streamId,
        before,
        after: summarizeToolCallsForDiag(toolCalls),
      });
      archiveCounter += 1;
      archived = [
        ...archived,
        {
          ...existing,
          archiveId: `${sessionId}::${actorId}::${archiveCounter}`,
          active: false,
          toolCalls,
          parts: syncToolParts(entryParts(existing), toolCalls),
          lastUpdate: Date.now(),
        },
      ];
    }

    const archivedPlan = [...archived]
      .reverse()
      .find(
        (entry) =>
          entry.sessionId === sessionId &&
          entry.actorId === actorId &&
          entry.planEntries.length > 0,
      );
    const planEntries = existing?.planEntries.length
      ? existing.planEntries
      : (archivedPlan?.planEntries ?? []);
    const persistedPlansBySession = persistSessionPlan(
      state.persistedPlansBySession,
      sessionId,
      actorId,
      planEntries,
    );
    set({
      byKey: next,
      archived,
      persistedPlansBySession,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  detachLiveStreamForPersist: (sessionId, actorId, streamId) => {
    const trimmed = streamId.trim();
    if (!trimmed) return;
    const key = k(sessionId, actorId);
    const state = get();
    const existing = state.byKey[key];
    if (!existing || existing.streamId !== trimmed) return;
    const next = { ...state.byKey };
    delete next[key];
    logInterruptMsgDiag("stream.detachForPersist", {
      sessionId,
      actorId,
      streamId: trimmed,
    });
    set({
      byKey: next,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  clearActor: (sessionId, actorId, opts) => {
    const state = get();
    const key = k(sessionId, actorId);
    const existing = state.byKey[key];
    const next = { ...state.byKey };
    delete next[key];
    const archived = opts?.includeArchives
      ? state.archived.filter(
          (entry) =>
            !(entry.sessionId === sessionId && entry.actorId === actorId),
        )
      : state.archived;
    const archivedPlan = [...archived]
      .reverse()
      .find(
        (entry) =>
          entry.sessionId === sessionId &&
          entry.actorId === actorId &&
          entry.planEntries.length > 0,
      );
    const planEntries = existing?.planEntries.length
      ? existing.planEntries
      : (archivedPlan?.planEntries ?? []);
    const persistedPlansBySession = persistSessionPlan(
      state.persistedPlansBySession,
      sessionId,
      actorId,
      planEntries,
    );
    set({
      byKey: next,
      archived,
      persistedPlansBySession,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  bindChildAcpSession: (sessionId, actorId, parentToolId, childAcpSessionId) => {
    const trimmedChild = childAcpSessionId.trim();
    const trimmedParent = parentToolId.trim();
    if (!trimmedChild || !trimmedParent) return;
    const state = get();
    const childAcpSessionToToolId = {
      ...state.childAcpSessionToToolId,
      [trimmedChild]: trimmedParent,
    };
    const subagentByToolId = {
      ...state.subagentByToolId,
      [trimmedParent]: state.subagentByToolId[trimmedParent] ?? {
        ...emptyEntry(sessionId, actorId),
        streamId: `${trimmedParent}::subagent`,
      },
    };
    set({
      childAcpSessionToToolId,
      subagentByToolId,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
    const pending = state.pendingSubagentEvents[trimmedChild] ?? [];
    if (pending.length === 0) return;
    for (const acpEvent of pending) {
      routeSubagentAcpEvent(sessionId, actorId, trimmedParent, acpEvent);
    }
    const nextPending = { ...get().pendingSubagentEvents };
    delete nextPending[trimmedChild];
    set({ pendingSubagentEvents: nextPending });
  },

  bufferPendingSubagentEvent: (childAcpSessionId, acpEvent) => {
    const trimmed = childAcpSessionId.trim();
    if (!trimmed) return;
    const state = get();
    set({
      pendingSubagentEvents: {
        ...state.pendingSubagentEvents,
        [trimmed]: [...(state.pendingSubagentEvents[trimmed] ?? []), acpEvent],
      },
    });
  },

  subAppendOutput: (parentToolId, sessionId, actorId, delta) => {
    if (!delta) return;
    const state = get();
    const entry = prepareSubagentMutation(state, parentToolId, sessionId, actorId);
    set({
      subagentByToolId: {
        ...state.subagentByToolId,
        [parentToolId]: {
          ...entry,
          sessionId,
          actorId,
          outputText: appendOverlappingChunk(entry.outputText, delta),
          parts: appendOutputToParts(entryParts(entry), delta),
          lastUpdate: Date.now(),
          active: true,
        },
      },
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  subAppendThinking: (parentToolId, sessionId, actorId, delta) => {
    if (!delta) return;
    const state = get();
    const entry = prepareSubagentMutation(state, parentToolId, sessionId, actorId);
    set({
      subagentByToolId: {
        ...state.subagentByToolId,
        [parentToolId]: {
          ...entry,
          sessionId,
          actorId,
          thinkingText: appendOverlappingChunk(entry.thinkingText, delta),
          parts: appendReasoningPart(entryParts(entry), delta),
          lastUpdate: Date.now(),
          active: true,
        },
      },
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  subPushToolUse: (parentToolId, sessionId, actorId, args) => {
    const { toolId, toolName, description, params, toolKind, content, locations, acpStatus, rawInput } =
      args;
    if (!toolId || toolName === "task") return;
    const state = get();
    const entry = prepareSubagentMutation(state, parentToolId, sessionId, actorId);
    if (entry.toolCalls.some((tc) => tc.id === toolId)) {
      const toolCalls = entry.toolCalls.map((tc) =>
        tc.id === toolId
          ? mergeToolUse(tc, {
              toolName,
              description,
              params,
              toolKind,
              content,
              locations,
              acpStatus,
              rawInput,
            })
          : tc,
      );
      set({
        subagentByToolId: {
          ...state.subagentByToolId,
          [parentToolId]: {
            ...entry,
            sessionId,
            actorId,
            toolCalls,
            parts: syncToolParts(entryParts(entry), toolCalls),
            lastUpdate: Date.now(),
            active: true,
          },
        },
        revisionBySession: bumpRevision(state.revisionBySession, sessionId),
      });
      return;
    }
    const newToolCall: ToolCall = {
      id: toolId,
      name: toolName || "unknown",
      toolKind: toolKind || undefined,
      acpStatus,
      content,
      locations,
      rawInput,
      status: "calling",
      arguments: toolUseArguments(params, description),
      startTime: new Date(),
    };
    set({
      subagentByToolId: {
        ...state.subagentByToolId,
        [parentToolId]: {
          ...entry,
          sessionId,
          actorId,
          toolCalls: [...entry.toolCalls, newToolCall],
          parts: [
            ...entryParts(entry),
            {
              id: `stream:subtool:${toolId}`,
              type: "tool-call",
              toolCallId: toolId,
              toolCall: newToolCall,
            },
          ],
          lastUpdate: Date.now(),
          active: true,
        },
      },
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  subCompleteToolUse: (parentToolId, sessionId, actorId, { toolId, success, summary, content, rawOutput }) => {
    if (!toolId) return;
    const state = get();
    const entry = state.subagentByToolId[parentToolId];
    if (!entry) return;
    const fallbackToolCall = completedToolPlaceholder(toolId, success, summary);
    const hasToolCall = entry.toolCalls.some((tc) => tc.id === toolId);
    const toolCalls = hasToolCall
      ? withCompletedTool(entry.toolCalls, toolId, success, summary, content, rawOutput)
      : [...entry.toolCalls, fallbackToolCall];
    const parts = hasToolCall
      ? syncToolParts(entryParts(entry), toolCalls)
      : [...entryParts(entry), toolCallPart(fallbackToolCall)];
    set({
      subagentByToolId: {
        ...state.subagentByToolId,
        [parentToolId]: {
          ...entry,
          toolCalls,
          parts,
          lastUpdate: Date.now(),
        },
      },
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  subSetError: (parentToolId, sessionId, actorId, message, details) => {
    const state = get();
    const entry = prepareSubagentMutation(state, parentToolId, sessionId, actorId);
    set({
      subagentByToolId: {
        ...state.subagentByToolId,
        [parentToolId]: {
          ...entry,
          sessionId,
          actorId,
          errorMessage: message,
          errorDetails: details,
          lastUpdate: Date.now(),
          active: false,
        },
      },
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  subMarkActive: (parentToolId, sessionId, actorId) => {
    const state = get();
    const entry = prepareSubagentMutation(state, parentToolId, sessionId, actorId);
    set({
      subagentByToolId: {
        ...state.subagentByToolId,
        [parentToolId]: {
          ...entry,
          sessionId,
          actorId,
          active: true,
          lastUpdate: Date.now(),
        },
      },
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  subFinish: (parentToolId) => {
    const state = get();
    const entry = state.subagentByToolId[parentToolId];
    if (!entry) return;
    const toolCalls = finishUnresolvedTools(entry.toolCalls);
    set({
      subagentByToolId: {
        ...state.subagentByToolId,
        [parentToolId]: {
          ...entry,
          toolCalls,
          parts: syncToolParts(entryParts(entry), toolCalls),
          active: false,
          lastUpdate: Date.now(),
        },
      },
      revisionBySession: bumpRevision(state.revisionBySession, entry.sessionId),
    });
  },

  archiveSubagentsForParent: (sessionId, actorId) => {
    const state = get();
    const archivedSubagentByToolId = { ...state.archivedSubagentByToolId };
    const subagentByToolId = { ...state.subagentByToolId };
    let childAcpSessionToToolId = state.childAcpSessionToToolId;
    let changed = false;
    for (const [toolId, entry] of Object.entries(state.subagentByToolId)) {
      if (entry.sessionId !== sessionId || entry.actorId !== actorId) continue;
      changed = true;
      archivedSubagentByToolId[toolId] = {
        ...entry,
        active: false,
        toolCalls: finishUnresolvedTools(entry.toolCalls),
        parts: syncToolParts(
          entryParts(entry),
          finishUnresolvedTools(entry.toolCalls),
        ),
      };
      delete subagentByToolId[toolId];
      childAcpSessionToToolId = pruneChildSessionMap(childAcpSessionToToolId, toolId);
    }
    if (!changed) return;
    set({
      subagentByToolId,
      archivedSubagentByToolId,
      childAcpSessionToToolId,
      pendingSubagentEvents: prunePendingSubagentEvents(
        state.pendingSubagentEvents,
        childAcpSessionToToolId,
      ),
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },

  clearSubagentsForSession: (sessionId) => {
    const state = get();
    const subagentByToolId: Record<string, AgentStreamEntry> = {};
    for (const [toolId, entry] of Object.entries(state.subagentByToolId)) {
      if (entry.sessionId !== sessionId) subagentByToolId[toolId] = entry;
    }
    const archivedSubagentByToolId: Record<string, AgentStreamEntry> = {};
    for (const [toolId, entry] of Object.entries(state.archivedSubagentByToolId)) {
      if (entry.sessionId !== sessionId) archivedSubagentByToolId[toolId] = entry;
    }
    const childAcpSessionToToolId: Record<string, string> = {};
    for (const [childSid, toolId] of Object.entries(state.childAcpSessionToToolId)) {
      const live = state.subagentByToolId[toolId] ?? state.archivedSubagentByToolId[toolId];
      if (live?.sessionId !== sessionId) childAcpSessionToToolId[childSid] = toolId;
    }
    const pendingSubagentEvents: Record<string, AcpEvent[]> = {};
    for (const [childSid, events] of Object.entries(state.pendingSubagentEvents)) {
      if (childAcpSessionToToolId[childSid]) {
        pendingSubagentEvents[childSid] = events;
      }
    }
    set({
      subagentByToolId,
      archivedSubagentByToolId,
      childAcpSessionToToolId,
      pendingSubagentEvents: prunePendingSubagentEvents(
        pendingSubagentEvents,
        childAcpSessionToToolId,
      ),
    });
  },

  clearSession: (sessionId) => {
    get().clearSubagentsForSession(sessionId);
    const state = get();
    const next: Record<string, AgentStreamEntry> = {};
    for (const [key, entry] of Object.entries(state.byKey)) {
      if (entry.sessionId !== sessionId) next[key] = entry;
    }
    const { [sessionId]: _removed, ...persistedPlansBySession } =
      state.persistedPlansBySession;
    set({
      byKey: next,
      archived: state.archived.filter((e) => e.sessionId !== sessionId),
      persistedPlansBySession,
      revisionBySession: bumpRevision(state.revisionBySession, sessionId),
    });
  },
}));

revisionFlushTarget = {
  setState: (partial) => {
    useV2StreamingStore.setState(partial);
  },
  getState: () => useV2StreamingStore.getState(),
};

/** Selector helper: get all streaming entries for a session (active + finalized
 * current turn) plus any archived prior turns. Ordered by lastUpdate so the
 * UI can render bubbles in chronological order. */
export function selectStreamsForSession(state: State, sessionId: string): AgentStreamEntry[] {
  const current = Object.values(state.byKey).filter((e) => e.sessionId === sessionId);
  const archived = state.archived.filter((e) => e.sessionId === sessionId);
  return [...archived, ...current].sort((a, b) => a.lastUpdate - b.lastUpdate);
}

export function isStreamInterruptible(entry: AgentStreamEntry): boolean {
  return entry.active && !entry.errorMessage;
}

export function selectPersistedPlanForSession(
  state: State,
  sessionId: string | null,
): PersistedSessionPlan | null {
  if (!sessionId) return null;
  return state.persistedPlansBySession[sessionId] ?? null;
}
