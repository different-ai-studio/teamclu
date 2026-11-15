import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatFileMenuHost } from "@/components/chat/ChatFileMenuHost";
import { ChatFilePreviewColumn, ChatFilePreviewToggle } from "@/components/chat/ChatFilePreviewColumn";
import { useChatFilePreviewStore } from "@/stores/chat-file-preview-store";

const { openChatHref, openPreviewTabFile, downloadedChatAttachmentPath, downloadChatAttachment, revealDownloadedChatAttachment } = vi.hoisted(() => ({
  openChatHref: vi.fn(),
  openPreviewTabFile: vi.fn(),
  downloadedChatAttachmentPath: vi.fn(async () => null as string | null),
  downloadChatAttachment: vi.fn(async () => undefined),
  revealDownloadedChatAttachment: vi.fn(async () => undefined),
}));

vi.mock("@/lib/messages/open-chat-file", () => ({
  openChatHref: (...args: unknown[]) => openChatHref(...args),
  openChatAttachment: vi.fn(),
  openPreviewTabFile: (...args: unknown[]) => openPreviewTabFile(...args),
  downloadedChatAttachmentPath: (...args: unknown[]) => downloadedChatAttachmentPath(...args),
  downloadChatAttachment: (...args: unknown[]) => downloadChatAttachment(...args),
  revealDownloadedChatAttachment: (...args: unknown[]) => revealDownloadedChatAttachment(...args),
}));

function resetPreview() {
  useChatFilePreviewStore.setState({
    tabs: [],
    activeId: null,
    collapsed: false,
    width: 420,
  });
}

describe("ChatFilePreviewColumn", () => {
  beforeEach(() => {
    resetPreview();
  });

  it("keeps markdown and html in tabs and collapses without dropping them", () => {
    useChatFilePreviewStore.getState().openTab({
      id: "/repo/周报.md",
      name: "周报.md",
      kind: "md",
      path: "/repo/周报.md",
      text: "# 周报",
    });
    useChatFilePreviewStore.getState().openTab({
      id: "/repo/落地页.html",
      name: "落地页.html",
      kind: "html",
      path: "/repo/落地页.html",
      text: "<p>落地页</p>",
    });

    render(
      <>
        <ChatFilePreviewToggle />
        <ChatFilePreviewColumn />
      </>,
    );

    expect(screen.getByRole("tab", { name: /周报\.md/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /落地页\.html/ })).toBeTruthy();
    expect(screen.getByLabelText("阅读面板")).toHaveStyle({ width: "420px" });

    fireEvent.click(screen.getByRole("button", { name: "收起阅读面板" }));
    expect(screen.getByLabelText("阅读面板")).toHaveStyle({ width: "0px" });
    expect(screen.getByRole("button", { name: "展开阅读面板" })).toBeTruthy();
    expect(useChatFilePreviewStore.getState().tabs).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "展开阅读面板" }));
    expect(screen.getByLabelText("阅读面板")).toHaveStyle({ width: "420px" });

    fireEvent.click(screen.getByRole("button", { name: "关闭 落地页.html" }));
    expect(screen.queryByRole("tab", { name: /落地页\.html/ })).toBeNull();
    expect(screen.getByRole("tab", { name: /周报\.md/ })).toBeTruthy();
  });
});

describe("ChatFileMenuHost", () => {
  beforeEach(() => {
    openChatHref.mockClear();
    openPreviewTabFile.mockClear();
    downloadChatAttachment.mockClear();
    revealDownloadedChatAttachment.mockClear();
    downloadedChatAttachmentPath.mockReset();
    downloadedChatAttachmentPath.mockResolvedValue(null);
  });

  function renderLink(href: string) {
    render(
      <>
        <div data-chat-messages>
          <a href={href}>目标</a>
        </div>
        <ChatFileMenuHost />
      </>,
    );
  }

  it("offers the side panel only for markdown and html", () => {
    renderLink("./docs/周报.md");
    fireEvent.contextMenu(screen.getByRole("link"));
    expect(screen.getByRole("button", { name: "在侧边栏打开" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "用默认程序打开" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "在侧边栏打开" }));
    expect(openChatHref).toHaveBeenCalledWith("./docs/周报.md", "sidebar");
  });

  it("offers only the default app for files the panel cannot render", () => {
    renderLink("./docs/说明.pdf");
    fireEvent.contextMenu(screen.getByRole("link"));
    expect(screen.queryByRole("button", { name: "在侧边栏打开" })).toBeNull();
    expect(screen.getByRole("button", { name: "用默认程序打开" })).toBeTruthy();
  });

  it("offers download until the attachment is saved, then reveal", async () => {
    const { rerender } = render(
      <>
        <button type="button" data-chat-attachment="" data-chat-filename="说明.pdf" data-chat-url="https://cdn.example/a.pdf">
          说明.pdf
        </button>
        <ChatFileMenuHost />
      </>,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "说明.pdf" }));
    const downloadItem = await screen.findByRole("button", { name: "下载" });
    const menuButtons = downloadItem.parentElement?.querySelectorAll("button");
    expect(menuButtons?.[0]).toBe(downloadItem);
    expect(screen.queryByRole("button", { name: "打开文件所在位置" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "下载" }));
    expect(downloadChatAttachment).toHaveBeenCalledWith({
      filename: "说明.pdf",
      url: "https://cdn.example/a.pdf",
      bucketPath: undefined,
      localPath: undefined,
    });

    downloadedChatAttachmentPath.mockResolvedValue("C:/repo/output/说明.pdf");
    rerender(
      <>
        <button type="button" data-chat-attachment="" data-chat-filename="说明.pdf" data-chat-url="https://cdn.example/a.pdf">
          说明.pdf
        </button>
        <ChatFileMenuHost />
      </>,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "说明.pdf" }));
    expect(await screen.findByRole("button", { name: "打开文件所在位置" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "下载" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开文件所在位置" }));
    expect(revealDownloadedChatAttachment).toHaveBeenCalled();
  });

  it("ignores links outside the chat", () => {
    render(
      <>
        <a href="./docs/周报.md">外面</a>
        <ChatFileMenuHost />
      </>,
    );
    fireEvent.contextMenu(screen.getByRole("link"));
    expect(screen.queryByRole("button", { name: "用默认程序打开" })).toBeNull();
  });
});
