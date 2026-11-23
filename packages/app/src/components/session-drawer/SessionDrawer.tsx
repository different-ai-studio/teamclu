import * as React from "react";
import { useTranslation } from "react-i18next";
import { Pin, PinOff, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUIStore } from "@/stores/ui";

/**
 * Where the session's side panels (files, actors, app settings) open: at the
 * right edge of column three, because they belong to the session on screen.
 *
 * Floating by default — over the conversation, so opening the file tree does
 * not reflow the chat — and closed by Esc or a click anywhere outside it.
 * Clicks inside it do not close it, so several files can be opened from the
 * tree in a row. Pinned, it docks into the row and pushes the conversation,
 * which is how it behaved before.
 */

/** Clicks on these never count as "outside": the drawer's own toggles, and
 * anything a panel inside it opened in a portal (menus, popovers, dialogs). */
const INSIDE_SELECTORS = [
  "[data-session-drawer-toggle]",
  "[data-radix-popper-content-wrapper]",
  "[role='dialog']",
  "[role='menu']",
  "[role='listbox']",
  "[data-sonner-toaster]",
].join(",");

export function SessionDrawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const pinned = useUIStore((s) => s.sessionDrawerPinned);
  const setPinned = useUIStore((s) => s.setSessionDrawerPinned);
  const ref = React.useRef<HTMLElement | null>(null);
  const floating = !pinned;

  React.useEffect(() => {
    if (!open || !floating) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (ref.current?.contains(target)) return;
      if (target.closest(INSIDE_SELECTORS)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Esc belongs to whatever has focus first (the composer, a dialog); the
      // drawer only takes it when focus is in the drawer or nowhere in
      // particular.
      const active = document.activeElement;
      if (active && active !== document.body && !ref.current?.contains(active)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, floating, onClose]);

  const pinLabel = pinned
    ? t("sessionDrawer.unpin", "Float over the conversation")
    : t("sessionDrawer.pin", "Dock beside the conversation");

  return (
    <aside
      ref={ref}
      data-testid="session-drawer"
      data-drawer-mode={floating ? "floating" : "docked"}
      aria-hidden={!open || undefined}
      className={cn(
        "flex h-full w-72 flex-col overflow-hidden border-border bg-background",
        "transition-[width,opacity,transform] duration-300 ease-out motion-reduce:transition-none",
        floating
          ? "absolute inset-y-0 right-0 z-30 border-l shadow-[-8px_0_24px_-12px_rgba(20,20,15,0.18)]"
          : "relative shrink-0 border-l",
        open
          ? "translate-x-0 opacity-100"
          : cn(
              "pointer-events-none translate-x-4 opacity-0",
              floating ? "invisible" : "w-0 border-l-0",
            ),
      )}
    >
      {open ? (
        <>
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border-soft pl-3 pr-1.5">
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-foreground">
              {title}
            </span>
            <button
              type="button"
              onClick={() => setPinned(!pinned)}
              title={pinLabel}
              aria-label={pinLabel}
              aria-pressed={pinned}
              data-testid="session-drawer-pin"
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                pinned
                  ? "bg-selected text-foreground"
                  : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground",
              )}
            >
              {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              title={t("common.close", "Close")}
              aria-label={t("common.close", "Close")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </>
      ) : null}
    </aside>
  );
}
