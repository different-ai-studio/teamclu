import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  parseChatTarget,
  supportsSidebarPreview,
} from "@/lib/messages/chat-open-target";
import {
  openChatAttachment,
  openChatHref,
  openPreviewTabFile,
  type ChatAttachmentTarget,
  type ChatOpenIntent,
} from "@/lib/messages/open-chat-file";

type MenuState = {
  x: number;
  y: number;
  sidebar: boolean;
  run: (intent: ChatOpenIntent) => void;
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
      setMenu({ x: event.clientX, y: event.clientY, sidebar, run });
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

  const left = Math.min(menu.x, window.innerWidth - 180);
  const top = Math.min(menu.y, window.innerHeight - (menu.sidebar ? 84 : 48));

  return (
    <div
      ref={menuRef}
      data-chat-file-menu
      className="fixed z-50 min-w-[168px] rounded-lg border border-border bg-paper p-1 shadow-[0_10px_28px_-16px_rgba(20,20,15,0.45)]"
      style={{ left, top }}
    >
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
    </div>
  );
}
