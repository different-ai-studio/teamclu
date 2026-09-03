import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { useSessionStore } from "@/stores/session-store";
import {
  resetSessionPermissionModesForTests,
} from "@/lib/session-permission-mode";
import { StreamingAgentsDock } from "../StreamingAgentsDock";

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

vi.mock("@/hooks/use-actor-display-name", () => ({
  useActorDisplayName: (actorId: string) => `Agent-${actorId}`,
}));

describe("StreamingAgentsDock", () => {
  beforeEach(() => {
    resetSessionPermissionModesForTests();
    useSessionStore.setState({
      activeSessionId: "sess-1",
      sessions: [{ id: "sess-1", messages: [] }],
      pendingPermissions: [],
      replyPermission: vi.fn(() => Promise.resolve()),
    });
  });

  it("embeds approval panel inside the streaming agent shell", () => {
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
      <StreamingAgentsDock
        agents={[{ actorId: "agent-1", displayName: "MACMINI" }]}
        onInterrupt={vi.fn()}
      />,
    );

    expect(screen.getByTestId("streaming-agents-dock")).toBeTruthy();
    expect(screen.getByTestId("streaming-agent-shell")).toBeTruthy();
    expect(screen.getByTestId("pending-permission-card")).toBeTruthy();
    expect(screen.getByTestId("streaming-agent-row")).toBeTruthy();
    expect(screen.getByText("ls -la")).toBeTruthy();
    expect(screen.queryByTestId("streaming-agent-stop")).toBeNull();
  });

  it("shows interrupt control when streaming without approval", () => {
    render(
      <StreamingAgentsDock
        agents={[{ actorId: "agent-1", displayName: "MACMINI" }]}
        onInterrupt={vi.fn()}
      />,
    );

    expect(screen.getByTestId("streaming-agent-stop")).toBeTruthy();
    expect(screen.queryByTestId("pending-permission-card")).toBeNull();
  });

  it("hides interrupt control while approval panel is open on the agent shell", () => {
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
      <StreamingAgentsDock
        agents={[{ actorId: "agent-1", displayName: "MACMINI" }]}
        onInterrupt={vi.fn()}
      />,
    );

    expect(screen.getByTestId("pending-permission-card")).toBeTruthy();
    expect(screen.queryByTestId("streaming-agent-stop")).toBeNull();
  });
});
