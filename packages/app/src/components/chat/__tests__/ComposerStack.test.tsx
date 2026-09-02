import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useSessionStore } from "@/stores/session";
import { resetSessionPermissionModesForTests } from "@/lib/session-permission-mode";
import { ComposerStack } from "../ComposerStack";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, options?: Record<string, unknown>) => {
      const template = fallback ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, token: string) =>
        String(options?.[token] ?? `{{${token}}}`),
      );
    },
  }),
}));

vi.mock("@/hooks/useActorDisplayName", () => ({
  useActorDisplayName: (actorId: string) => `Agent-${actorId}`,
}));

vi.mock("../StreamingAgentBubble", () => ({
  StreamingAgentBubble: ({ entry, variant }: { entry: { actorId: string }; variant?: string }) => (
    <div data-testid="v2-streaming-agent" data-variant={variant} data-actor-id={entry.actorId}>
      live
    </div>
  ),
}));

function makeEntry(actorId: string, lastUpdate: number) {
  return {
    sessionId: "sess-1",
    actorId,
    outputText: "hello",
    thinkingText: "",
    parts: [],
    toolCalls: [],
    planEntries: [],
    pendingPermissionsByRequestId: {},
    errorMessage: null,
    errorDetails: null,
    lastUpdate,
    active: true,
    streamId: `sess-1::${actorId}::1`,
  };
}

describe("ComposerStack", () => {
  beforeEach(() => {
    resetSessionPermissionModesForTests();
    useSessionStore.setState({
      activeSessionId: "sess-1",
      sessions: [{ id: "sess-1", messages: [] }],
      pendingPermissions: [],
      replyPermission: vi.fn(() => Promise.resolve()),
    });
  });

  it("renders a single unified shell with agent strip and input zone", () => {
    render(
      <ComposerStack
        agents={[{ actorId: "agent-1", displayName: "MACMINI" }]}
        onInterrupt={vi.fn()}
        todos={[{ id: "1", content: "Task A", status: "pending", priority: "high" } as never]}
      >
        <div data-testid="child-input">input</div>
      </ComposerStack>,
    );

    expect(screen.getByTestId("composer-stack")).toBeTruthy();
    expect(screen.getByTestId("streaming-agent-row")).toBeTruthy();
    expect(screen.getByTestId("composer-plan-slot")).toBeTruthy();
    expect(screen.getByTestId("composer-input-zone")).toBeTruthy();
    expect(screen.getByTestId("child-input")).toBeTruthy();
  });

  it("embeds approval inside the same shell and hides interrupt", () => {
    useSessionStore.setState({
      pendingPermissions: [
        {
          permission: { id: "perm-1", permission: "bash", patterns: ["ls -la"] },
          childSessionId: null,
          ownerSessionId: "sess-1",
        },
      ],
    });

    render(
      <ComposerStack
        agents={[{ actorId: "agent-1", displayName: "MACMINI" }]}
        onInterrupt={vi.fn()}
      >
        <div>input</div>
      </ComposerStack>,
    );

    expect(screen.getByTestId("pending-permission-card")).toBeTruthy();
    expect(screen.queryByTestId("streaming-agent-stop")).toBeNull();
  });

  it("expands at most one live panel and renders dock bubble", () => {
    render(
      <ComposerStack
        agents={[
          { actorId: "a1", displayName: "A1", entry: makeEntry("a1", 1) as never },
          { actorId: "a2", displayName: "A2", entry: makeEntry("a2", 2) as never },
        ]}
        onInterrupt={vi.fn()}
      >
        <div>input</div>
      </ComposerStack>,
    );

    const rows = screen.getAllByTestId("streaming-agent-row");
    expect(rows).toHaveLength(2);
    // Newest (a2) expanded by default
    expect(rows[1]?.getAttribute("data-expanded")).toBe("true");
    expect(rows[0]?.getAttribute("data-expanded")).toBe("false");
    expect(screen.getByTestId("v2-streaming-agent").getAttribute("data-variant")).toBe("dock");

    const strips = screen.getAllByTestId("streaming-agent-strip");
    fireEvent.click(strips[0]!);
    expect(screen.getAllByTestId("streaming-agent-row")[0]?.getAttribute("data-expanded")).toBe(
      "true",
    );
    expect(screen.getAllByTestId("streaming-agent-row")[1]?.getAttribute("data-expanded")).toBe(
      "false",
    );
  });

  it("scrolls the live panel to bottom as stream content grows", async () => {
    const entry = makeEntry("a1", 1) as never;
    const { rerender } = render(
      <ComposerStack
        agents={[{ actorId: "a1", displayName: "A1", entry }]}
        onInterrupt={vi.fn()}
      >
        <div>input</div>
      </ComposerStack>,
    );

    const scrollEl = screen.getByTestId("streaming-agent-live-scroll");
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(scrollEl, "scrollHeight", { configurable: true, value: 400 });
    scrollEl.scrollTop = 0;

    const taller = { ...makeEntry("a1", 2), outputText: "hello\n".repeat(40) } as never;
    rerender(
      <ComposerStack
        agents={[{ actorId: "a1", displayName: "A1", entry: taller }]}
        onInterrupt={vi.fn()}
      >
        <div>input</div>
      </ComposerStack>,
    );

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(screen.getByTestId("streaming-agent-live-scroll").scrollTop).toBe(300);
  });

  it("enlarges live process into an out-of-flow float panel", () => {
    render(
      <ComposerStack
        agents={[{ actorId: "a1", displayName: "A1", entry: makeEntry("a1", 1) as never }]}
        onInterrupt={vi.fn()}
      >
        <div>input</div>
      </ComposerStack>,
    );

    expect(screen.getByTestId("streaming-agent-row").getAttribute("data-expanded")).toBe(
      "true",
    );
    expect(screen.getByTestId("streaming-agent-live-panel").getAttribute("data-open")).toBe(
      "true",
    );
    expect(screen.queryByTestId("streaming-agent-live-float")).toBeNull();

    fireEvent.click(screen.getByTestId("streaming-agent-enlarge"));

    expect(screen.getByTestId("streaming-agent-row").getAttribute("data-enlarged")).toBe(
      "true",
    );
    expect(screen.getByTestId("streaming-agent-live-panel").getAttribute("data-open")).toBe(
      "false",
    );
    expect(screen.getByTestId("streaming-agent-live-float")).toBeTruthy();
    expect(screen.getByTestId("streaming-agent-live-scroll")).toBeTruthy();

    fireEvent.click(screen.getByTestId("streaming-agent-float-restore"));

    expect(screen.getByTestId("streaming-agent-row").getAttribute("data-enlarged")).toBe(
      "false",
    );
    expect(screen.getByTestId("streaming-agent-live-panel").getAttribute("data-open")).toBe(
      "true",
    );
    expect(screen.queryByTestId("streaming-agent-live-float")).toBeNull();
  });

  it("keeps live context visible with an in-stack question and hides text input", () => {
    render(
      <ComposerStack
        agents={[{ actorId: "a1", displayName: "A1", entry: makeEntry("a1", 1) as never }]}
        onInterrupt={vi.fn()}
        pendingQuestion={{
          questionId: "q-event-1",
          toolCallId: "tool-q",
          messageId: "msg-1",
          questions: [
            {
              id: "q-1",
              header: "Pick one",
              question: "Which option?",
              options: [{ label: "A", value: "a" }],
            },
          ],
          agentActorId: "a1",
        }}
      >
        <div data-testid="child-input">input</div>
      </ComposerStack>,
    );

    expect(screen.getByTestId("streaming-agent-live-panel").getAttribute("data-open")).toBe(
      "true",
    );
    expect(screen.getByTestId("question-input-dock")).toBeTruthy();
    expect(screen.getByTestId("composer-input-zone").className).toContain("hidden");
  });

  it("restores the enlarge float on Escape", () => {
    render(
      <ComposerStack
        agents={[{ actorId: "a1", displayName: "A1", entry: makeEntry("a1", 1) as never }]}
        onInterrupt={vi.fn()}
      >
        <div>input</div>
      </ComposerStack>,
    );

    fireEvent.click(screen.getByTestId("streaming-agent-enlarge"));
    expect(screen.getByTestId("streaming-agent-live-float")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByTestId("streaming-agent-live-float")).toBeNull();
    expect(screen.getByTestId("streaming-agent-row").getAttribute("data-enlarged")).toBe(
      "false",
    );
  });
});
