import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageKind } from "@/lib/proto/teamclu_pb";
import { useSessionMessageStore } from "@/stores/session-message-store";

const mocks = vi.hoisted(() => ({
  listMessages: vi.fn(),
  listSessionDisplayRows: vi.fn(),
  reloadAndSwitchTo: vi.fn(),
}));

vi.mock("@/lib/backend", () => ({
  getBackend: () => ({
    messages: { listMessages: mocks.listMessages },
    sessions: {
      listSessionDisplayRows: mocks.listSessionDisplayRows,
    },
  }),
}));

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => ({
      team: { id: "team-1" },
      reloadAndSwitchTo: mocks.reloadAndSwitchTo,
    }),
  },
}));

vi.mock("@/lib/utils", () => ({
  isTauri: () => false,
}));

import { ensureCronSessionVisible, hydrateCronSessionMessages } from "@/lib/cron/cron-session-messages";
import { isScheduledSession } from "@/lib/session/session-origin";
import { useSessionListStore } from "@/stores/session-list-store";

beforeEach(() => {
  vi.clearAllMocks();
  useSessionMessageStore.setState({
    messages: {},
    messageRefreshTrigger: 0,
    messageRefreshForceFull: false,
  });
});

describe("hydrateCronSessionMessages", () => {
  it("maps cloud rows into the message store", async () => {
    mocks.listMessages.mockResolvedValueOnce({
      nextCursor: null,
      rows: [
      {
        id: "m1",
        team_id: "t1",
        session_id: "s1",
        turn_id: null,
        sender_actor_id: "agent-1",
        reply_to_message_id: null,
        kind: "agent_reply",
        content: "hello from cloud",
        metadata: null,
        model: null,
        created_at: "2026-06-01T07:00:00.000Z",
        updated_at: "2026-06-01T07:00:00.000Z",
      },
      ],
    });

    const count = await hydrateCronSessionMessages("s1");
    expect(count).toBe(1);
    const stored = useSessionMessageStore.getState().messages.s1;
    expect(stored).toHaveLength(1);
    expect(stored?.[0]?.content).toBe("hello from cloud");
    expect(stored?.[0]?.kind).toBe(MessageKind.AGENT_REPLY);
  });

  it("falls back to run summary when cloud has no messages", async () => {
    mocks.listMessages.mockResolvedValueOnce({ rows: [], nextCursor: null });

    const count = await hydrateCronSessionMessages("s1", {
      fallbackSummary: "北极熊笑话",
      runId: "run-1",
    });

    expect(count).toBe(1);
    const stored = useSessionMessageStore.getState().messages.s1;
    expect(stored?.[0]?.content).toBe("北极熊笑话");
    expect(stored?.[0]?.messageId).toBe("cron-summary-run-1");
  });
});

describe("ensureCronSessionVisible", () => {
  beforeEach(() => {
    useSessionListStore.setState({ rows: [] });
    mocks.listSessionDisplayRows.mockResolvedValue([{ id: "s-cron", title: "Cron: Test" }]);
  });

  it("marks the synthesised row as cron-origin so it lands in the 定时任务 view", async () => {
    await ensureCronSessionVisible("s-cron");

    const [row] = useSessionListStore.getState().rows;
    expect(row?.id).toBe("s-cron");
    expect(row?.source).toBe("cron");
    // Both sidebar surfaces route through this predicate; without `source` the
    // row would show up in the ordinary 会话 list instead.
    expect(isScheduledSession(row!, new Set())).toBe(true);
  });
});
