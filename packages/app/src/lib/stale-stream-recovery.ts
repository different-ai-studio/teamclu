import { AgentStatus } from "@/lib/proto/amux_pb";
import { isTerminalAgentStatus } from "@/lib/live-agent-stream";
import {
  resolveSessionAttachmentEntry,
  type RuntimeStateEntry,
} from "@/stores/runtime-state-store";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";

/**
 * Recovery for live turns whose terminal `statusChange` never arrived.
 *
 * The 8s watchdog in App.tsx is armed inside the terminal branch, so it only
 * covers "terminal arrived but the daemon AGENT_REPLY did not". MQTT is QoS0:
 * when the terminal event itself is dropped (daemon stall, reconnect gap) no
 * timer is ever armed and the composer dock spins forever.
 */
type StaleLiveStream = {
  sessionId: string;
  actorId: string;
  /** `runtime-terminal`: the runtime retain proves the turn ended. */
  reason: "runtime-terminal" | "silent";
};

/** Silence this long, with nothing in flight, means the turn is gone. Generous
 * on purpose: a long tool call is silent too, and cutting a live turn short is
 * worse than a late recovery. */
export const STREAM_SILENCE_RECOVERY_MS = 120_000;

/** How often the client re-checks live docks against runtime state. */
export const STALE_STREAM_SWEEP_MS = 5_000;

function hasToolCallInFlight(entry: AgentStreamEntry): boolean {
  return (entry.toolCalls ?? []).some(
    (call) => call.status === "calling" || call.status === "waiting",
  );
}

export function findStaleLiveStreams(args: {
  byKey: Record<string, AgentStreamEntry>;
  byRuntimeId: Record<string, RuntimeStateEntry>;
  now: number;
  silenceMs?: number;
}): StaleLiveStream[] {
  const silenceMs = args.silenceMs ?? STREAM_SILENCE_RECOVERY_MS;
  const stale: StaleLiveStream[] = [];

  for (const entry of Object.values(args.byKey)) {
    if (!entry.active) continue;
    const runtime = resolveSessionAttachmentEntry(
      entry.actorId,
      entry.sessionId,
      args.byRuntimeId,
    );

    // Actor state is retained and can be replayed on reconnect. Only the
    // current session's attachment can prove this live turn ended; sibling
    // sessions for the same actor are unrelated.
    if (
      runtime &&
      isTerminalAgentStatus(runtime.info.status) &&
      runtime.lastUpdated > entry.lastUpdate
    ) {
      stale.push({
        sessionId: entry.sessionId,
        actorId: entry.actorId,
        reason: "runtime-terminal",
      });
      continue;
    }

    if (runtime?.info.status === AgentStatus.ACTIVE) continue;
    if (hasToolCallInFlight(entry)) continue;
    if (args.now - entry.lastUpdate > silenceMs) {
      stale.push({
        sessionId: entry.sessionId,
        actorId: entry.actorId,
        reason: "silent",
      });
    }
  }

  return stale;
}
