import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateSessionTitle: vi.fn().mockResolvedValue(undefined),
  rows: [] as Array<{ id: string; title: string }>,
}));

vi.mock("@/stores/session-list-store", () => ({
  useSessionListStore: {
    getState: () => ({
      rows: mocks.rows,
      updateSessionTitle: mocks.updateSessionTitle,
    }),
  },
}));

import {
  isPlaceholderSessionTitle,
  markSessionNeedsAutoTitle,
  maybeAutoTitleSessionFromFirstMessage,
  resetSessionAutoTitlePendingForTests,
  summarizeSessionTitleFromMessage,
} from "@/lib/session/session-auto-title";

describe("session-auto-title", () => {
  beforeEach(() => {
    mocks.updateSessionTitle.mockClear();
    mocks.rows = [];
    resetSessionAutoTitlePendingForTests();
  });

  it("summarizes the first line and caps at 80 chars", () => {
    expect(summarizeSessionTitleFromMessage("  hello\nworld  ")).toBe("hello");
    expect(summarizeSessionTitleFromMessage("x".repeat(100))).toHaveLength(80);
  });

  it("skips structured agent/human mention markup", () => {
    expect(
      summarizeSessionTitleFromMessage(
        "[Mentioned agents: SPRBOT]\n\n深圳宝安有什么推荐的美食?",
      ),
    ).toBe("深圳宝安有什么推荐的美食?");
    expect(
      summarizeSessionTitleFromMessage(
        "[Mentioned: Haigang Ye|instruction: 提及 Haigang Ye] 帮我看下结算",
      ),
    ).toBe("帮我看下结算");
  });

  it("detects placeholder titles from quick-empty / New chat", () => {
    expect(isPlaceholderSessionTitle("SPRBOT (19:17)")).toBe(true);
    expect(isPlaceholderSessionTitle("New chat")).toBe(true);
    expect(isPlaceholderSessionTitle("New Chat")).toBe(true);
    expect(isPlaceholderSessionTitle("")).toBe(true);
    expect(isPlaceholderSessionTitle("Fix login redirect")).toBe(false);
    expect(isPlaceholderSessionTitle("SPRBOT notes")).toBe(false);
  });

  it("renames only when the session was marked for auto-title", async () => {
    mocks.rows = [{ id: "sess-1", title: "SPRBOT (19:17)" }];
    markSessionNeedsAutoTitle("sess-1");

    const renamed = await maybeAutoTitleSessionFromFirstMessage(
      "sess-1",
      "帮我查一下结算单\n第二行",
    );

    expect(renamed).toBe(true);
    expect(mocks.updateSessionTitle).toHaveBeenCalledWith("sess-1", "帮我查一下结算单");
  });

  it("skips unmarked sessions even when the title looks like HH:mm", async () => {
    mocks.rows = [{ id: "sess-1", title: "Standup (09:30)" }];

    const renamed = await maybeAutoTitleSessionFromFirstMessage("sess-1", "今日议程");

    expect(renamed).toBe(false);
    expect(mocks.updateSessionTitle).not.toHaveBeenCalled();
  });

  it("skips when the title was already customized after mark", async () => {
    mocks.rows = [{ id: "sess-1", title: "结算单核对" }];
    markSessionNeedsAutoTitle("sess-1");

    const renamed = await maybeAutoTitleSessionFromFirstMessage("sess-1", "帮我查一下");

    expect(renamed).toBe(false);
    expect(mocks.updateSessionTitle).not.toHaveBeenCalled();
  });

  it("skips empty message content", async () => {
    mocks.rows = [{ id: "sess-1", title: "SPRBOT (19:17)" }];
    markSessionNeedsAutoTitle("sess-1");

    const renamed = await maybeAutoTitleSessionFromFirstMessage("sess-1", "   \n  ");

    expect(renamed).toBe(false);
    expect(mocks.updateSessionTitle).not.toHaveBeenCalled();
  });
});
