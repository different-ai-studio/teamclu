import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  parseChatTarget,
  supportsSidebarPreview,
} from "@/lib/messages/chat-open-target";
import {
  downloadChatAttachment,
  downloadedChatAttachmentPath,
  openChatAttachment,
  openChatHref,
  openPreviewTabFile,
  revealDownloadedChatAttachment,
  type ChatAttachmentTarget,
  type ChatOpenIntent,
} from "@/lib/messages/open-chat-file";

type MenuState = {
  x: number;
  y: number;
  sidebar: boolean;
  run: (intent: ChatOpenIntent) => void;
  attachment: ChatAttachmentTarget | null;
  /** Set when `attachment` is already saved under the workspace output folder. */
  downloadedPath: string | null;
};

function attachmentFrom(element: HTMLElement): ChatAttachmentTarget | null {
  if (!element.hasAttribute("data-chat-attachment")) return null;
  const filename = element.dataset.chatFilename?.trim();
  if (!filename) return null;
  return {
    filename,
    url: element.dataset.chatUrl || undefined,
    bucketPath: element.dataset.chatBucket || undefined,
    localPath: element.dataset.chatLocal || undefined,
  };
}

export function ChatFileMenuHost() {
  const { t } = useTranslation();
  const [menu, setMenu] = React.useState<MenuState | null>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const requestRef = React.useRef(0);

  React.useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-chat-file-menu]")) return;

      const tab = target.closest("[data-preview-tab]");
      const attachmentEl = target.closest("[data-chat-attachment]");
      const link = target.closest("a[href]");
      const inChat = Boolean(target.closest("[data-chat-messages], [data-chat-preview]"));
      if (!tab && !attachmentEl && !(link && inChat)) return;
      if (link instanceof HTMLElement && link.hasAttribute("data-admin-console-entry")) return;

      let sidebar = false;
      let run: ((intent: ChatOpenIntent) => void) | null = null;

      if (tab instanceof HTMLElement) {
        const name = tab.dataset.previewName?.trim() ?? "";
        const path = tab.dataset.previewPath || undefined;
        if (!name) return;
        sidebar = true;
        run = (intent) => void openPreviewTabFile(path, name, intent);
      } else if (attachmentEl instanceof HTMLElement) {
        const attachment = attachmentFrom(attachmentEl);
        if (!attachment) return;
        sidebar = supportsSidebarPreview(attachment.filename);
        run = (intent) => void openChatAttachment(attachment, intent);
      } else if (link instanceof HTMLAnchorElement && inChat) {
        const href = link.getAttribute("href")?.trim() ?? "";
        const parsed = parseChatTarget(href);
        if (parsed.kind === "ignore") return;
        sidebar = parsed.kind === "path" && supportsSidebarPreview(href);
        run = (intent) => void openChatHref(href, intent);
      }

      if (!run) return;
      event.preventDefault();
      const request = ++requestRef.current;
      const point = { x: event.clientX, y: event.clientY, sidebar, run };
      if (!(attachmentEl instanceof HTMLElement)) {
        setMenu({ ...point, attachment: null, downloadedPath: null });
        return;
      }
      const attachment = attachmentFrom(attachmentEl);
      if (!attachment) return;
      void downloadedChatAttachmentPath(attachment).then((downloadedPath) => {
        if (requestRef.current !== request) return;
        setMenu({ ...point, attachment, downloadedPath });
      });
    };

    const onPointerDown = (event: PointerEvent) => {
      const node = menuRef.current;
      if (!node) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      setMenu(null);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };

    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!menu) return null;

  const rows = (menu.sidebar ? 1 : 0) + 1 + (menu.attachment ? 1 : 0);
  const left = Math.min(menu.x, window.innerWidth - 196);
  const top = Math.min(menu.y, window.innerHeight - (rows * 32 + 12));

  return (
    <div
      ref={menuRef}
      data-chat-file-menu
      className="fixed z-50 min-w-[188px] rounded-lg border border-border bg-paper p-1 shadow-[0_10px_28px_-16px_rgba(20,20,15,0.45)]"
      style={{ left, top }}
    >
      {menu.attachment && !menu.downloadedPath ? (
        <button
          type="button"
          className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-selected"
          onClick={() => {
            const attachment = menu.attachment;
            setMenu(null);
            if (attachment) void downloadChatAttachment(attachment);
          }}
        >
          {t("chat.fileOpen.download", "下载")}
        </button>
      ) : null}
      {menu.sidebar ? (
        <button
          type="button"
          className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-selected"
          onClick={() => {
            menu.run("sidebar");
            setMenu(null);
          }}
        >
          {t("chat.fileOpen.openInSidebar", "在侧边栏打开")}
        </button>
      ) : null}
      <button
        type="button"
        className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-selected"
        onClick={() => {
          menu.run("default-app");
          setMenu(null);
        }}
      >
        {t("chat.fileOpen.openWithDefaultApp", "用默认程序打开")}
      </button>
      {menu.attachment && menu.downloadedPath ? (
        <button
          type="button"
          className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 hover:bg-selected"
          onClick={() => {
            const attachment = menu.attachment;
            setMenu(null);
            if (attachment) void revealDownloadedChatAttachment(attachment);
          }}
        >
          {t("chat.fileOpen.reveal", "打开文件所在位置")}
        </button>
      ) : null}
    </div>
  );
}
