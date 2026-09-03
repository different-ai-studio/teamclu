/** Intercept in-document link clicks and route them through the app (Tauri only).
 *
 * STR-11: split out of `hooks/useAppInit.ts`, which exported ten unrelated
 * hooks and one event-name constant from one 647-line file.
 */
import { useEffect } from "react";
import { isTauri } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabs";
import { urlToLabel } from "@/lib/ui/webview-utils";

export function useExternalLinkHandler() {
  useEffect(() => {
    if (!isTauri()) return;

    const handler = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest?.("a");
      if (!anchor) return;
      // SEC-5: the one way a link gets an admin-console tab WITH the user's
      // session injected. Only first-party JSX can set a data attribute —
      // react-markdown drops raw HTML, so content (agent output, teammates'
      // messages, files) can never carry it. Every other https link, wherever
      // it came from, opens as a plain webview tab with no session.
      if (anchor.hasAttribute("data-admin-console-entry")) {
        e.preventDefault();
        e.stopPropagation();
        void import("@/lib/extension/admin-sso-inject").then(({ openAdminConsoleTab }) => {
          openAdminConsoleTab();
        });
        return;
      }
      const href = anchor.getAttribute("href");
      if (href && /^https?:\/\//.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        useTabsStore.getState().openTab({
          type: "webview",
          target: href,
          label: urlToLabel(href),
        });
      }
    };

    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);
}
