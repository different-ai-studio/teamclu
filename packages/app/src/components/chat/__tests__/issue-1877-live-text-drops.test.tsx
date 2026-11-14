import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { StreamingAgentBubble } from "../StreamingAgentBubble";
import { useSessionMessageStore } from "@/stores/session-message-store";
import {
  isStreamInterruptible,
  streamEntryKey,
  useV2StreamingStore,
} from "@/stores/v2-streaming-store";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn(),
}));

const SESSION = "s1";
const ACTOR = "agent-a";
const ESSAY = "报销规则说明".repeat(20);
const NO_MESSAGES: { content: string }[] = [];

/**
 * Same split as the app: the live dock draws the stream, the message area
 * draws session messages only.
 */
function Screen() {
  const entry = useV2StreamingStore((s) => s.byKey[streamEntryKey(SESSION, ACTOR)]);
  const messages = useSessionMessageStore((s) => s.messages[SESSION] ?? NO_MESSAGES);
  const showDock = Boolean(entry && isStreamInterruptible(entry));
  return (
    <div>
      <div data-testid="dock">
        {showDock ? <StreamingAgentBubble entry={entry!} variant="dock" /> : null}
      </div>
      <div data-testid="messages">{messages.map((m) => m.content).join("\n")}</div>
    </div>
  );
}

beforeEach(() => {
  useV2StreamingStore.setState({ byKey: {}, archived: [], revisionBySession: {} });
  useSessionMessageStore.setState({
    messages: {},
    messageRefreshTrigger: 0,
    messageRefreshForceFull: false,
  });
});

describe("issue 1877 live text drops", () => {
  it("keeps the dock up for the whole turn and leaves the message area empty", async () => {
    act(() => {
      useV2StreamingStore.getState().appendThinking(SESSION, ACTOR, ESSAY);
    });

    const view = render(<Screen />);
    await waitFor(() => {
      expect(view.getByTestId("dock").textContent).toContain("报销规则说明");
    });
    expect(view.getByTestId("messages").textContent).not.toContain("报销规则");
    expect(isStreamInterruptible(
      useV2StreamingStore.getState().byKey[streamEntryKey(SESSION, ACTOR)]!,
    )).toBe(true);

    act(() => {
      useV2StreamingStore.getState().closeLiveDock(SESSION, ACTOR, { reason: "test" });
    });

    expect(view.getByTestId("dock").textContent ?? "").not.toContain("报销规则");
    expect(view.getByTestId("messages").textContent ?? "").toBe("");
    expect(isStreamInterruptible(
      useV2StreamingStore.getState().byKey[streamEntryKey(SESSION, ACTOR)]!,
    )).toBe(false);
  });
});
