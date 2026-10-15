import type {
  SessionMessage,
  StreamingBuffer,
  TimelineEvent,
} from "./session-types";

export type TimelineState = {
  messages: SessionMessage[];
  streamingByAgent: Map<string, StreamingBuffer>;
};

export function emptyTimelineState(): TimelineState {
  return { messages: [], streamingByAgent: new Map() };
}

function timeValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareMessages(a: SessionMessage, b: SessionMessage): number {
  const dt = timeValue(a.createdAt) - timeValue(b.createdAt);
  if (dt !== 0) return dt;
  return a.messageId.localeCompare(b.messageId);
}

function insertSorted(messages: SessionMessage[], next: SessionMessage): SessionMessage[] {
  const idx = messages.findIndex((m) => m.messageId === next.messageId);
  if (idx >= 0) {
    if (next.content.length > messages[idx].content.length) {
      const out = messages.slice();
      out[idx] = next;
      return out;
    }
    return messages;
  }
  // A live event almost always lands at the end, so check that first and
  // binary-search otherwise — a full re-sort per streamed event parsed every
  // timestamp in the session each time.
  const out = messages.slice();
  let lo = 0;
  let hi = out.length;
  if (hi > 0 && compareMessages(out[hi - 1], next) <= 0) {
    lo = hi;
  }
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareMessages(out[mid], next) <= 0) lo = mid + 1;
    else hi = mid;
  }
  out.splice(lo, 0, next);
  return out;
}

function mergePageMessages(
  messages: readonly SessionMessage[],
  page: readonly SessionMessage[],
): SessionMessage[] {
  let windowStart = Number.POSITIVE_INFINITY;
  const pageIds = new Set<string>();
  for (const message of page) {
    pageIds.add(message.messageId);
    windowStart = Math.min(windowStart, timeValue(message.createdAt));
  }

  const older = messages.filter(
    (message) => !pageIds.has(message.messageId) && timeValue(message.createdAt) < windowStart,
  );
  // Page rows win over the copies already held: for a committed message the
  // server row is the complete one.
  const out = [...older, ...page];
  out.sort(compareMessages);
  return out;
}

/**
 * Fold the server's newest page onto a timeline that may already reach further
 * back than the page does.
 *
 * The page is authoritative **for the window it covers**: a row inside that
 * window which the server no longer returns has been deleted, and has to go —
 * that is how a delete propagates on the refresh that follows it. Anything
 * older than the page's first row is history the server was never asked about
 * (a back-scrolled page, or rows hydrated from disk), so it stays.
 *
 * The whole timeline used to be replaced by the page. That was invisible while
 * every load fetched the entire history, and became lossy the moment #842
 * capped a page at 200: a cold start would paint the cached transcript and then
 * collapse it to the newest page, and a reconnect refresh would throw away
 * whatever the user had scrolled back to.
 *
 * An empty page means an empty session — if older rows existed, the newest page
 * would have returned them — so it clears the messages rather than preserving
 * rows the server no longer has.
 *
 * Streaming buffers are carried through, minus any the page settles: a partial
 * whose turn finished while the app was away arrives here as a committed row,
 * and would otherwise sit next to its own finished message.
 */
export function mergeNewestPage(
  state: TimelineState,
  page: readonly SessionMessage[],
): TimelineState {
  let streamingByAgent = state.streamingByAgent;
  for (const message of page) {
    streamingByAgent = clearStreamingByMessageId(streamingByAgent, message);
  }
  return {
    messages: page.length === 0 ? [] : mergePageMessages(state.messages, page),
    streamingByAgent,
  };
}

function clearStreamingByMessageId(
  streamingByAgent: Map<string, StreamingBuffer>,
  message: SessionMessage,
): Map<string, StreamingBuffer> {
  let changed = false;
  const next = new Map(streamingByAgent);
  const kind = message.kind.trim().toLowerCase();
  const mayBeFinalReply = kind === "agent_reply" || kind === "text";
  for (const [agentId, buf] of next) {
    if (
      buf.messageId === message.messageId ||
      (mayBeFinalReply && agentId === message.senderActorId)
    ) {
      next.delete(agentId);
      changed = true;
    }
  }
  return changed ? next : streamingByAgent;
}

export function reduceTimeline(state: TimelineState, event: TimelineEvent): TimelineState {
  switch (event.kind) {
    case "messageCommitted": {
      const messages = insertSorted(state.messages, event.message);
      const streamingByAgent = clearStreamingByMessageId(
        state.streamingByAgent,
        event.message,
      );
      if (messages === state.messages && streamingByAgent === state.streamingByAgent) {
        return state;
      }
      return { messages, streamingByAgent };
    }
    case "streamingDelta": {
      const prev = state.streamingByAgent.get(event.agentId);
      const next: StreamingBuffer = prev && prev.messageId === event.messageId
        ? {
            ...prev,
            isComplete: event.isComplete ?? prev.isComplete,
            model: event.model || prev.model,
            text: prev.text + event.deltaText,
          }
        : {
            isComplete: event.isComplete,
            messageId: event.messageId,
            model: event.model,
            text: event.deltaText,
            kind: event.messageKind,
            startedAt: event.createdAt,
            senderActorId: event.agentId,
          };
      const streamingByAgent = new Map(state.streamingByAgent);
      streamingByAgent.set(event.agentId, next);
      return { ...state, streamingByAgent };
    }
    case "streamingDone": {
      if (!state.streamingByAgent.has(event.agentId)) return state;
      const streamingByAgent = new Map(state.streamingByAgent);
      streamingByAgent.delete(event.agentId);
      return { ...state, streamingByAgent };
    }
  }
}
