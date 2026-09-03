import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth-store";

const { isTauriMock } = vi.hoisted(() => ({ isTauriMock: vi.fn() }));
vi.mock("@/lib/utils", async (orig) => ({ ...(await orig<object>()), isTauri: isTauriMock }));
// Auth methods come from the Cloud API now, so turn them on where the
// component reads them instead of faking a build config that no longer
// carries flags.
vi.mock("@/lib/config/remote-features", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const features = {
    updater: true,
    auth: { google: true, wechat: true, phone: false, password: false, webSSO: true },
    channels: { discord: false, feishu: false, email: false, kook: false, wecom: false, wechat: false, seatalk: false },
    apps: false,
    lockLlmConfig: false,
  };
  return { ...actual, useFeatures: () => features, getFeatures: () => features };
});

import { OAuthButtons } from "../LoginScreen";

beforeEach(() => isTauriMock.mockReset());
afterEach(() => act(() => useAuthStore.setState({ oauthPending: null })));

describe("OAuthButtons", () => {
  it("renders WeChat + Google buttons in Tauri when both flags on", () => {
    isTauriMock.mockReturnValue(true);
    render(<OAuthButtons />);
    // Test env runs zh-CN — assert Chinese labels.
    expect(screen.getByText("使用微信登录")).toBeTruthy();
    expect(screen.getByText("使用 Google 登录")).toBeTruthy();
  });

  it("renders 快捷登录 button when features.auth.webSSO is on", () => {
    isTauriMock.mockReturnValue(true);
    render(<OAuthButtons />);
    expect(screen.getByText("快捷登录")).toBeTruthy();
  });

  it("renders nothing on web (non-Tauri)", () => {
    isTauriMock.mockReturnValue(false);
    const { container } = render(<OAuthButtons />);
    expect(container.firstChild).toBeNull();
  });

  it("renders Google in the extension, where chrome.identity can capture the redirect", () => {
    isTauriMock.mockReturnValue(false);
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: "abcdefghijklmnop" } };
    try {
      render(<OAuthButtons />);
      expect(screen.getByText("使用 Google 登录")).toBeTruthy();
    } finally {
      delete (globalThis as { chrome?: unknown }).chrome;
    }
  });

  it("keeps WeChat and 快捷登录 desktop-only in the extension", () => {
    isTauriMock.mockReturnValue(false);
    (globalThis as { chrome?: unknown }).chrome = { runtime: { id: "abcdefghijklmnop" } };
    try {
      render(<OAuthButtons />);
      // Both need native pieces the extension has no equivalent of: a webview
      // for 快捷登录, a registered redirect domain for WeChat.
      expect(screen.queryByText("使用微信登录")).toBeNull();
      expect(screen.queryByText("快捷登录")).toBeNull();
    } finally {
      delete (globalThis as { chrome?: unknown }).chrome;
    }
  });

  it("shows a cancel control instead of provider buttons while OAuth is pending", () => {
    isTauriMock.mockReturnValue(true);
    const cancelOAuth = vi.fn();
    act(() => useAuthStore.setState({ oauthPending: "google", cancelOAuth }));
    render(<OAuthButtons />);
    // Provider buttons are replaced by the waiting + cancel affordance.
    expect(screen.queryByText("使用 Google 登录")).toBeNull();
    expect(screen.queryByText("使用微信登录")).toBeNull();
    const cancel = screen.getByText("取消并换一种方式");
    fireEvent.click(cancel);
    expect(cancelOAuth).toHaveBeenCalledTimes(1);
  });

  it("shows webSSO waiting message + cancel while webSsoPending is true", () => {
    isTauriMock.mockReturnValue(true);
    const cancelWebSso = vi.fn();
    act(() => useAuthStore.setState({ webSsoPending: true, cancelWebSso }));
    render(<OAuthButtons />);
    // Provider buttons replaced by webSSO waiting affordance.
    expect(screen.queryByText("使用 Google 登录")).toBeNull();
    expect(screen.getByText("在窗口里登录完成后回到这里。")).toBeTruthy();
    const cancel = screen.getByText("取消并换一种方式");
    fireEvent.click(cancel);
    expect(cancelWebSso).toHaveBeenCalledTimes(1);
  });
});
