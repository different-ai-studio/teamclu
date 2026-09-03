import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  getMode: vi.fn(() => "default" as "default" | "fullAccess"),
  setSessionPermissionMode: vi.fn(),
  flushSessionPendingPermissions: vi.fn(() => Promise.resolve()),
  subscribe: vi.fn((cb: () => void) => {
    mocks.listener = cb;
    return () => {};
  }),
  listener: null as (() => void) | null,
  isSoloBuild: vi.fn(() => false),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@/lib/session/session-permission-mode", () => ({
  useSessionPermissionMode: () => mocks.getMode(),
  setSessionPermissionMode: mocks.setSessionPermissionMode,
}));

vi.mock("@/lib/teamclu/flush-session-pending-permissions", () => ({
  flushSessionPendingPermissions: mocks.flushSessionPendingPermissions,
}));

vi.mock("@/lib/config/solo-build", () => ({
  isSoloBuild: () => mocks.isSoloBuild(),
}));

import { PermissionApprovalModeSelect } from "../PermissionApprovalModeSelect";

describe("PermissionApprovalModeSelect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMode.mockReturnValue("default");
    mocks.isSoloBuild.mockReturnValue(false);
  });

  it("hidden when sessionId is null", () => {
    const { container } = render(<PermissionApprovalModeSelect sessionId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("hidden in solo builds", () => {
    mocks.isSoloBuild.mockReturnValue(true);
    const { container } = render(<PermissionApprovalModeSelect sessionId="sess-a" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows default label for session", () => {
    render(<PermissionApprovalModeSelect sessionId="sess-a" />);
    expect(screen.getByTestId("permission-approval-mode-trigger")).toHaveTextContent(
      "默认权限",
    );
  });

  it("sets fullAccess only for the active session and flushes pending", async () => {
    const user = userEvent.setup();
    render(<PermissionApprovalModeSelect sessionId="sess-a" />);
    await user.click(screen.getByTestId("permission-approval-mode-trigger"));
    await user.click(screen.getByTestId("permission-mode-full-access"));

    expect(mocks.setSessionPermissionMode).toHaveBeenCalledWith("sess-a", "fullAccess");
    expect(mocks.flushSessionPendingPermissions).toHaveBeenCalledWith("sess-a");
  });
});
