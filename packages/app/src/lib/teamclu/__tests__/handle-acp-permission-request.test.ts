import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  shouldAutoAllow: vi.fn(() => false),
  replyAcpPermission: vi.fn(() => Promise.resolve()),
  setPermissionRequest: vi.fn(),
  notificationSend: vi.fn(() => Promise.resolve("sent" as const)),
}));

vi.mock("@/lib/notification-service", () => ({
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

vi.mock("@/lib/session-permission-mode", () => ({
  shouldAutoAllowSessionPermissions: mocks.shouldAutoAllow,
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
} from "../handle-acp-permission-request";

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
    mocks.shouldAutoAllow.mockReturnValue(false);
  });

  it("writes pending permission in default mode", async () => {
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

  it("auto-replies without writing store in fullAccess mode", async () => {
    mocks.shouldAutoAllow.mockReturnValue(true);

    await handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });

    expect(mocks.replyAcpPermission).toHaveBeenCalledWith({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      requestId: "perm-1",
      decision: "allow",
    });
    expect(mocks.setPermissionRequest).not.toHaveBeenCalled();
    expect(mocks.notificationSend).not.toHaveBeenCalled();
  });

  it("falls back to pending on auto-reply failure", async () => {
    mocks.shouldAutoAllow.mockReturnValue(true);
    mocks.replyAcpPermission.mockRejectedValueOnce(new Error("mqtt down"));

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

  it("dedupes in-flight requestId", async () => {
    mocks.shouldAutoAllow.mockReturnValue(true);
    let resolveReply!: () => void;
    mocks.replyAcpPermission.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveReply = resolve;
        }),
    );

    const first = handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });
    const second = handleAcpPermissionRequest({
      sessionId: "sess-1",
      agentActorId: "agent-1",
      request: sampleRequest,
    });

    resolveReply();
    await Promise.all([first, second]);

    expect(mocks.replyAcpPermission).toHaveBeenCalledTimes(1);
  });
});
