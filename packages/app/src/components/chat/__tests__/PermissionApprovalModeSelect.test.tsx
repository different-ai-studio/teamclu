import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  getMode: vi.fn(() => "default" as "default" | "fullAccess"),
  setSessionPermissionMode: vi.fn(),
  syncSessionPermissionModeToDaemon: vi.fn(() =>
    Promise.resolve({ accepted: true, effectiveMode: "full_access" }),
  ),
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

vi.mock("@/lib/teamclu/sync-session-permission-mode", () => ({
  syncSessionPermissionModeToDaemon: mocks.syncSessionPermissionModeToDaemon,
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

  it("sets fullAccess and syncs to daemon", async () => {
    const user = userEvent.setup();
    render(<PermissionApprovalModeSelect sessionId="sess-a" />);
    await user.click(screen.getByTestId("permission-approval-mode-trigger"));
    await user.click(screen.getByTestId("permission-mode-full-access"));

    expect(mocks.setSessionPermissionMode).toHaveBeenCalledWith("sess-a", "fullAccess");
    expect(mocks.syncSessionPermissionModeToDaemon).toHaveBeenCalledWith(
      "sess-a",
      "fullAccess",
    );
  });

  it("syncs default mode to daemon when switching back", async () => {
    mocks.getMode.mockReturnValue("fullAccess");
    const user = userEvent.setup();
    render(<PermissionApprovalModeSelect sessionId="sess-a" />);
    await user.click(screen.getByTestId("permission-approval-mode-trigger"));
    await user.click(screen.getByTestId("permission-mode-default"));

    expect(mocks.setSessionPermissionMode).toHaveBeenCalledWith("sess-a", "default");
    expect(mocks.syncSessionPermissionModeToDaemon).toHaveBeenCalledWith("sess-a", "default");
  });
});
