import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/utils", () => ({ isTauri: () => isTauriMock() }));

import { logSignOut } from "@/lib/auth/sign-out-log";

describe("logSignOut", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    isTauriMock.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("writes the reason and fields to the desktop log file", () => {
    isTauriMock.mockReturnValue(true);

    logSignOut("team_bootstrap_auth_rejected", {
      user: "user-1",
      server: "https://api.example.com",
      detail: "401 missing_auth; refresh: No refresh token available.",
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [command, args] = invokeMock.mock.calls[0];
    expect(command).toBe("plugin:log|log");
    expect(args.level).toBe(3);
    expect(args.location).toBe("auth");
    expect(args.message).toBe(
      '[auth] sign-out reason=team_bootstrap_auth_rejected user="user-1" server="https://api.example.com" detail="401 missing_auth; refresh: No refresh token available."',
    );
  });

  it("leaves out fields that have no value", () => {
    isTauriMock.mockReturnValue(true);

    logSignOut("user_menu", { user: "user-1", server: undefined, detail: null });

    expect(invokeMock.mock.calls[0][1].message).toBe('[auth] sign-out reason=user_menu user="user-1"');
  });

  it("only logs to the console outside the desktop app", () => {
    isTauriMock.mockReturnValue(false);

    logSignOut("user_menu");

    expect(invokeMock).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith("[auth] sign-out reason=user_menu");
  });

  it("never throws when the log command is unavailable", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockRejectedValue(new Error("log plugin missing"));

    expect(() => logSignOut("user_menu")).not.toThrow();
    await Promise.resolve();
  });
});
