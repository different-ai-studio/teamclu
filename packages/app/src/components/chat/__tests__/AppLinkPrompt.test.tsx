import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const linkMock = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/lib/apps/link-session-app", () => ({ linkSessionToApp: linkMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AppLinkPrompt } from "@/components/chat/AppLinkPrompt";
import { useSessionListStore, type SessionListEntry } from "@/stores/session-list-store";
import type { ToolCall } from "@/stores/session-types";

const ENVELOPE = JSON.stringify({
  v: 1,
  ok: true,
  data: { action: "create", app: { id: "app-1", name: "报销助手" } },
});

const createCall: ToolCall = {
  id: "tc-1",
  name: "bash",
  status: "completed",
  arguments: { command: "amuxd app create --name 报销助手" },
  result: ENVELOPE,
  startTime: new Date(0),
};

const message = {
  sessionId: "sess-1",
  parts: [{ id: "p1", type: "tool-call", toolCall: createCall }],
  toolCalls: [],
};

function seedRow(patch: Partial<SessionListEntry> = {}) {
  const row = {
    id: "sess-1",
    team_id: "team-1",
    title: "Chat",
    mode: "collab",
    app_id: null,
    source: "user",
    last_message_at: null,
    created_at: "2026-11-27T00:00:00Z",
    updated_at: "2026-11-27T00:00:00Z",
    ...patch,
  } as SessionListEntry;
  useSessionListStore.setState({ rows: [row] });
}

describe("AppLinkPrompt", () => {
  beforeEach(() => {
    localStorage.clear();
    linkMock.mockClear();
  });
  afterEach(() => {
    useSessionListStore.setState({ rows: [] });
  });

  it("offers to link a regular session to the app its agent created", async () => {
    seedRow();
    render(<AppLinkPrompt message={message} />);
    expect(screen.getByTestId("app-link-prompt").textContent).toContain("报销助手");
    await act(async () => {
      fireEvent.click(screen.getByTestId("app-link-prompt-link"));
    });
    expect(linkMock).toHaveBeenCalledWith("sess-1", "app-1");
  });

  it("goes away once the session row carries the app", async () => {
    seedRow();
    render(<AppLinkPrompt message={message} />);
    act(() => seedRow({ app_id: "app-1" }));
    await waitFor(() => expect(screen.queryByTestId("app-link-prompt")).toBeNull());
  });

  it("is not shown for a session that already has an app, or a channel session", () => {
    seedRow({ app_id: "app-other" });
    const { unmount } = render(<AppLinkPrompt message={message} />);
    expect(screen.queryByTestId("app-link-prompt")).toBeNull();
    unmount();
    seedRow({ source: "gateway" });
    render(<AppLinkPrompt message={message} />);
    expect(screen.queryByTestId("app-link-prompt")).toBeNull();
  });

  it("does not ask again in a session after 'Not now'", () => {
    seedRow();
    const { unmount } = render(<AppLinkPrompt message={message} />);
    fireEvent.click(screen.getByTestId("app-link-prompt-dismiss"));
    expect(screen.queryByTestId("app-link-prompt")).toBeNull();
    unmount();
    render(<AppLinkPrompt message={message} />);
    expect(screen.queryByTestId("app-link-prompt")).toBeNull();
    expect(linkMock).not.toHaveBeenCalled();
  });

  it("is not shown for a message without an app create", () => {
    seedRow();
    render(<AppLinkPrompt message={{ sessionId: "sess-1", parts: [], toolCalls: [] }} />);
    expect(screen.queryByTestId("app-link-prompt")).toBeNull();
  });
});
