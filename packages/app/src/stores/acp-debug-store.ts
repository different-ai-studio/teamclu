import { create } from "zustand";
import { appendAcpDebugLineToFile } from "@/lib/diagnostics/acp-debug-file-log";
import { appStoragePrefix } from "@/lib/config/build-config";
import type { AcpEvent } from "@/lib/proto/amux_pb";

const ACP_DEBUG_ENABLED_KEY = `${appStoragePrefix}-acp-stream-debug`;

function readAcpDebugEnabled(): boolean {
  if (import.meta.env.VITE_ACP_DEBUG_STREAM === "true") return true;
  try {
    return localStorage.getItem(ACP_DEBUG_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

/** In-memory ring buffer for the debug panel (disk log keeps full history). */
export const ACP_DEBUG_MAX_LINES = 2000;
/** Max lines rendered in the panel scroll area. */
export const ACP_DEBUG_PANEL_LINES = 200;

export type AcpDebugLine = {
  id: string;
  ts: number;
  sessionId: string;
  topic: string;
  actorId: string;
  eventCase: string;
  payload: unknown;
};

function serializeAcpPayload(event: AcpEvent | undefined): unknown {
  if (!event?.event) return null;
  const { case: eventCase, value } = event.event;
  if (!eventCase) return null;
  try {
    return JSON.parse(
      JSON.stringify(
        { case: eventCase, value, model: event.model ?? "" },
        (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    );
  } catch {
    return { case: eventCase, value: String(value) };
  }
}

interface State {
  lines: AcpDebugLine[];
  enabled: boolean;
  append: (input: {
    sessionId?: string;
    topic: string;
    actorId?: string;
    /** e.g. live:acp.event, runtime_state, client:runtime_start */
    eventCase?: string;
    acpEvent?: AcpEvent;
    envelopeMeta?: Record<string, unknown>;
    payload?: unknown;
  }) => void;
  clear: () => void;
  setEnabled: (enabled: boolean) => void;
}

/**
 * Appends are driven straight off the MQTT/SSE firehose — one per live event,
 * which during a stream means one per delta chunk. A `set()` per line is a
 * synchronous React render per line, and a burst (a streaming reply, or the
 * retained-message flood on reconnect) walks React past its nested-update limit
 * and throws "Maximum update depth exceeded".
 *
 * So coalesce: queue the lines and flush them in a single `set` on the next
 * microtask, mirroring `enqueueRuntimeStateUpdate` in the runtime-state store.
 * The disk log stays per-line — it is async I/O and never touches React.
 */
let pendingLines: AcpDebugLine[] = [];
let flushScheduled = false;

function flushPendingLines(): void {
  flushScheduled = false;
  const queued = pendingLines;
  pendingLines = [];
  if (queued.length === 0) return;
  useAcpDebugStore.setState((state) => {
    const next = [...state.lines, ...queued];
    if (next.length > ACP_DEBUG_MAX_LINES) {
      next.splice(0, next.length - ACP_DEBUG_MAX_LINES);
    }
    return { lines: next };
  });
}

function enqueueLine(line: AcpDebugLine): void {
  pendingLines.push(line);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushPendingLines);
}

export const useAcpDebugStore = create<State>((set, get) => ({
  lines: [],
  enabled: readAcpDebugEnabled(),
  append: (input) => {
    if (!get().enabled) return;
    const line: AcpDebugLine = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      sessionId: input.sessionId ?? "",
      topic: input.topic,
      actorId: input.actorId ?? "",
      eventCase:
        input.eventCase ??
        (input.acpEvent?.event?.case ? `live:${input.acpEvent.event.case}` : "(none)"),
      payload:
        input.payload ??
        (input.envelopeMeta
          ? { envelope: input.envelopeMeta, acp: serializeAcpPayload(input.acpEvent) }
          : serializeAcpPayload(input.acpEvent)),
    };
    enqueueLine(line);
    void appendAcpDebugLineToFile(line);
  },
  clear: () => {
    pendingLines = [];
    set({ lines: [] });
  },
  setEnabled: (enabled) => {
    try {
      localStorage.setItem(ACP_DEBUG_ENABLED_KEY, String(enabled));
    } catch {
      /* ignore */
    }
    set({ enabled });
  },
}));

export function isAcpDebugPanelVisible(): boolean {
  return useAcpDebugStore.getState().enabled;
}
