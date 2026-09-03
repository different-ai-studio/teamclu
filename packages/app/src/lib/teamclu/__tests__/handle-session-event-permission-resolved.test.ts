import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findV2PendingPermission: vi.fn(),
  clearPermissionRequest: vi.fn(),
  setState: vi.fn(),
}));

vi.mock("@/lib/teamclu/reply-acp-permission", () => ({
  findV2PendingPermission: mocks.findV2PendingPermission,
}));

vi.mock("@/stores/v2-streaming-store", () => ({
  useV2StreamingStore: {
    getState: () => ({
      clearPermissionRequest: mocks.clearPermissionRequest,
    }),
  },
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: {
    setState: mocks.setState,
  },
}));

import {
  handleSessionEventPermissionResolved,
  resetPermissionResolvedTtlForTests,
  wasPermissionRecentlyResolved,
} from "../handle-session-event-permission-resolved";

describe("handleSessionEventPermissionResolved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPermissionResolvedTtlForTests();
  });

  it("clears v2 pending via requestId scan and marks resolved TTL", () => {
    mocks.findV2PendingPermission.mockReturnValue({
      sessionId: "sess-1",
      actorId: "agent-1",
      request: { requestId: "perm-1" },
    });

    handleSessionEventPermissionResolved({ requestId: "perm-1" });

    expect(mocks.clearPermissionRequest).toHaveBeenCalledWith(
      "sess-1",
      "agent-1",
      "perm-1",
    );
    expect(wasPermissionRecentlyResolved("perm-1")).toBe(true);
    expect(mocks.setState).toHaveBeenCalled();
  });

  it("still marks TTL when no pending entry exists (reorder)", () => {
    mocks.findV2PendingPermission.mockReturnValue(null);

    handleSessionEventPermissionResolved({ requestId: "perm-late" });

    expect(mocks.clearPermissionRequest).not.toHaveBeenCalled();
    expect(wasPermissionRecentlyResolved("perm-late")).toBe(true);
  });

  it("ignores empty requestId", () => {
    handleSessionEventPermissionResolved({ requestId: "  " });
    expect(mocks.findV2PendingPermission).not.toHaveBeenCalled();
    expect(wasPermissionRecentlyResolved("")).toBe(false);
  });
});
