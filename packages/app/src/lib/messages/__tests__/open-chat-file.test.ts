import { beforeEach, describe, expect, it, vi } from "vitest";

const { openWithDefaultApp, attachmentPathExists, fetchAgentReplyAttachmentBytes, toastError } = vi.hoisted(() => ({
  openWithDefaultApp: vi.fn(async () => undefined),
  attachmentPathExists: vi.fn(async () => true),
  fetchAgentReplyAttachmentBytes: vi.fn(async () => {
    throw new Error("no bytes");
  }),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));
vi.mock("@/lib/i18n", () => ({ default: { t: (_key: string, fallback?: string) => fallback ?? _key } }));
vi.mock("@/lib/utils", () => ({ isTauri: () => true, openExternalUrl: vi.fn() }));
vi.mock("@/lib/fs-scope", () => ({ allowFsScopeDirs: vi.fn(async () => undefined) }));
vi.mock("@/stores/workspace", () => ({
  useWorkspaceStore: { getState: () => ({ workspacePath: "C:/repo" }) },
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: { getState: () => ({ activeSessionId: null }) },
}));
vi.mock("@/stores/runtime-state-store", () => ({
  useRuntimeStateStore: { getState: () => ({ byRuntimeId: {} }) },
}));
vi.mock("@/lib/attachments/attachment-download-index", () => ({
  attachmentPathExists: (...args: unknown[]) => attachmentPathExists(...args),
  getCachedAttachmentPath: () => null,
  normalizeAttachmentUrlKey: (url: string) => url,
  setCachedAttachmentPath: vi.fn(),
}));
vi.mock("@/lib/attachments/download-remote-attachment", () => ({
  fetchAgentReplyAttachmentBytes: (...args: unknown[]) => fetchAgentReplyAttachmentBytes(...args),
}));
vi.mock("@/components/workspace/file-tree-operations", () => ({
  openWithDefaultApp: (...args: unknown[]) => openWithDefaultApp(...args),
  revealInFileManager: vi.fn(),
}));

import { openChatAttachment } from "@/lib/messages/open-chat-file";

describe("openChatAttachment", () => {
  beforeEach(() => {
    openWithDefaultApp.mockClear();
    toastError.mockClear();
    fetchAgentReplyAttachmentBytes.mockClear();
    attachmentPathExists.mockReset();
    attachmentPathExists.mockResolvedValue(true);
  });

  it("opens a local-only attachment that sits in the workspace", async () => {
    await openChatAttachment({ filename: "note.pdf", localPath: "C:/repo/note.pdf" }, "default-app");

    expect(openWithDefaultApp).toHaveBeenCalledWith("C:/repo/note.pdf");
    expect(toastError).not.toHaveBeenCalled();
    expect(fetchAgentReplyAttachmentBytes).not.toHaveBeenCalled();
  });

  it("refuses a local-only attachment outside the workspace", async () => {
    await openChatAttachment({ filename: "note.pdf", localPath: "C:/other/note.pdf" }, "default-app");

    expect(openWithDefaultApp).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("这个路径不在当前会话的目录里");
  });

  it("downloads when a remote url is present, even if a local path is too", async () => {
    await openChatAttachment({
      filename: "note.pdf",
      url: "https://cdn.example/note.pdf",
      localPath: "C:/repo/note.pdf",
    });

    expect(fetchAgentReplyAttachmentBytes).toHaveBeenCalled();
    expect(openWithDefaultApp).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith("下载失败");
  });
});
