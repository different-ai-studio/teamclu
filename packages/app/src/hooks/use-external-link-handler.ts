/** Intercept in-document link clicks and open them outside the app (Tauri only).
 *
 * STR-11: split out of `hooks/useAppInit.ts`, which exported ten unrelated
 * hooks and one event-name constant from one 647-line file.
 */
import { useEffect } from "react";
import { isTauri, openExternalUrl } from "@/lib/utils";

export function useExternalLinkHandler() {
  useEffect(() => {
    if (!isTauri()) return;

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
      // In-document http(s) links open in the system browser. The chat stays
      // put; openExternalUrl refuses anything that is not http(s) or mailto.
      if (href && /^https?:\/\//.test(href)) {
        e.preventDefault();
        e.stopPropagation();
        void openExternalUrl(href);
      }
    };

    document.addEventListener("click", handler, true);
    return () => document.removeEventListener("click", handler, true);
  }, []);
}
