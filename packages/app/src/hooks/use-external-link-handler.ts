/** Intercept in-document link clicks and open them outside the app (Tauri only).
 *
 * STR-11: split out of `hooks/useAppInit.ts`, which exported ten unrelated
 * hooks and one event-name constant from one 647-line file.
 */
import { useEffect } from "react";
import { isTauri, openExternalUrl } from "@/lib/utils";
import { parseChatTarget } from "@/lib/messages/chat-open-target";
import { openChatHref } from "@/lib/messages/open-chat-file";

export function useExternalLinkHandler() {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest?.("a");
      if (!anchor) return;
      // SEC-5: the one way a link gets an admin-console tab WITH the user's
      // session injected. Only first-party JSX can set a data attribute —
      // react-markdown drops raw HTML, so content (agent output, teammates'
      // messages, files) can never carry it. Every other https link opens in
      // the system browser and leaves the chat in place.
      if (anchor.hasAttribute("data-admin-console-entry")) {
        e.preventDefault();
        e.stopPropagation();
        void import("@/lib/extension/admin-sso-inject").then(({ openAdminConsoleTab }) => {
          openAdminConsoleTab();
        });
        return;
      }
      const href = anchor.getAttribute("href");
      if (!href) return;
      const parsed = parseChatTarget(href);
      // Web links leave the chat and open in the system browser. Local paths
      // open in the side column (markdown / html) or the default app.
      if (parsed.kind === "web") {
        // The browser build follows http(s) and mailto itself. The desktop
        // webview would navigate away, so those leave through the shell.
        if (!isTauri()) return;
        e.preventDefault();
        e.stopPropagation();
        void openExternalUrl(parsed.url);
        return;
      }
      if (parsed.kind === "path") {
        // Only chat and the reading column. A path-shaped href elsewhere
        // (for example an in-app route) stays a normal link.
        if (!anchor.closest("[data-chat-messages], [data-chat-preview]")) return;
        e.preventDefault();
        e.stopPropagation();
        void openChatHref(href);
      }
    };

    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);
}
