import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replyAcpPermission: vi.fn(() => Promise.resolve()),
  setPermissionRequest: vi.fn(),
  notificationSend: vi.fn(() => Promise.resolve("sent" as const)),
}));

vi.mock("@/lib/ui/notification-service", () => ({
  notificationService: { send: mocks.notificationSend },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setFocus: vi.fn(),
    unminimize: vi.fn(),
  }),
}));

vi.mock("@/stores/session-list-store", () => ({
  useSessionListStore: {
    getState: () => ({ rows: [{ id: "sess-1", title: "Test session" }] }),
  },
}));

vi.mock("@/stores/session-selection-store", () => ({
  useSessionSelectionStore: {
    getState: () => ({ setActiveSession: vi.fn(async () => {}) }),
  },
}));

vi.mock("@/lib/teamclu/reply-acp-permission", () => ({
  replyAcpPermission: mocks.replyAcpPermission,
}));

vi.mock("@/stores/v2-streaming-store", () => ({
  useV2StreamingStore: {
    getState: () => ({
      setPermissionRequest: mocks.setPermissionRequest,
    }),
  },
}));

vi.mock("@/stores/current-team", () => ({
  useCurrentTeamStore: {
    getState: () => ({ currentMember: { id: "member-me" } }),
  },
}));

vi.mock("@/lib/teamclu/handle-session-event-permission-resolved", () => ({
  wasPermissionRecentlyResolved: () => false,
}));

import {
  handleAcpPermissionRequest,
  resetAcpPermissionInFlightForTests,
} from "@/lib/teamclu/handle-acp-permission-request";

const sampleRequest = {
  requestId: "perm-1",
  toolName: "bash",
  description: "run ls",
  params: { command: "ls" },
};

describe("handleAcpPermissionRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAcpPermissionInFlightForTests();
  });

  it("writes pending permission for interactive member", async () => {
    await handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });

    expect(mocks.setPermissionRequest).toHaveBeenCalledWith(
      "sess-1",
      "agent-1",
      sampleRequest,
    );
    expect(mocks.replyAcpPermission).not.toHaveBeenCalled();
    expect(mocks.notificationSend).toHaveBeenCalledOnce();
  });

  it("ignores empty requestId", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: { ...sampleRequest, requestId: "  " },
    });

    expect(mocks.setPermissionRequest).not.toHaveBeenCalled();
    expect(mocks.replyAcpPermission).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("dedupes OS banner after successful send", async () => {
    await handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });
    await handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });

    expect(mocks.notificationSend).toHaveBeenCalledOnce();
  });

  it("retries OS banner when first send was suppressed", async () => {
    mocks.notificationSend.mockResolvedValueOnce("skipped");
    mocks.notificationSend.mockResolvedValueOnce("sent");

    await handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });
    await handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });

    expect(mocks.notificationSend).toHaveBeenCalledTimes(2);
  });
});
