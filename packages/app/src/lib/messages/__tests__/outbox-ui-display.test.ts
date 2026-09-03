import { describe, expect, it } from "vitest";
import {
  sessionHasAgentStreamActivitySince,
  sessionHasMentionedRuntimeActiveSince,
} from "@/lib/messages/outbox-ui-display";
import { AgentStatus } from "@/lib/proto/amux_pb";
import type { RuntimeStateEntry } from "@/stores/runtime-state-store";
import type { AgentStreamEntry } from "@/stores/v2-streaming-store";

const baseEntry = (
  overrides: Partial<AgentStreamEntry> & Pick<AgentStreamEntry, "sessionId" | "lastUpdate">,
): AgentStreamEntry => ({
  actorId: "agent-1",
  outputText: "",
  thinkingText: "",
  parts: [],
  toolCalls: [],
  planEntries: [],
  pendingPermissionsByRequestId: {},
  errorMessage: null,
  errorDetails: null,
  active: true,
  streamId: "s1::agent-1::1",
  ...overrides,
});

describe("sessionHasAgentStreamActivitySince", () => {
  const since = "2026-06-03T10:34:10.000Z";

  it("returns false when no stream activity in session", () => {
    expect(
      sessionHasAgentStreamActivitySince("s1", since, { byKey: {}, archived: [] }),
    ).toBe(false);
  });

  it("returns true when live stream lastUpdate is at or after outbox createdAt", () => {
    expect(
      sessionHasAgentStreamActivitySince("s1", since, {
        byKey: {
          "s1::agent-1": baseEntry({
            sessionId: "s1",
            lastUpdate: new Date("2026-06-03T10:34:18.000Z").getTime(),
          }),
        },
        archived: [],
      }),
    ).toBe(true);
  });

  it("returns false when stream activity predates the outbox row", () => {
    expect(
      sessionHasAgentStreamActivitySince("s1", since, {
        byKey: {
          "s1::agent-1": baseEntry({
            sessionId: "s1",
            lastUpdate: new Date("2026-06-03T10:34:05.000Z").getTime(),
          }),
        },
        archived: [],
      }),
    ).toBe(false);
  });

  it("returns true for archived stream rows in the same session", () => {
    expect(
      sessionHasAgentStreamActivitySince("s1", since, {
        byKey: {},
        archived: [
          {
            ...baseEntry({
              sessionId: "s1",
              lastUpdate: new Date("2026-06-03T10:34:19.000Z").getTime(),
              active: false,
            }),
            archiveId: "s1::agent-1::arch-1",
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("sessionHasMentionedRuntimeActiveSince", () => {
  const since = "2026-06-03T11:12:30.000Z";
  const agentId = "b2d7df56-6cc8-4646-9352-f0f119a44f11";

  const runtimeEntry = (
    status: AgentStatus,
    lastUpdated: string,
  ): RuntimeStateEntry => ({
    daemonActorId: agentId,
    lastUpdated: new Date(lastUpdated).getTime(),
    info: {
      runtimeId: "session-1",
      agentType: 0,
      status,
      availableModels: [],
      currentModel: "",
    } as RuntimeStateEntry["info"],
  });

  it("returns true when a mentioned agent runtime is ACTIVE after send", () => {
    expect(
      sessionHasMentionedRuntimeActiveSince(
        [agentId],
        since,
        {
          [`${agentId}::session-1`]: runtimeEntry(
            AgentStatus.ACTIVE,
            "2026-06-03T11:12:35.000Z",
          ),
        },
      ),
    ).toBe(true);
  });

  it("returns false when runtime ACTIVE predates the outbox row", () => {
    expect(
      sessionHasMentionedRuntimeActiveSince(
        [agentId],
        since,
        {
          [`${agentId}::session-1`]: runtimeEntry(
            AgentStatus.ACTIVE,
            "2026-06-03T11:12:20.000Z",
          ),
        },
      ),
    ).toBe(false);
  });
});
