import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

import {
  attachTerminal,
  onTerminalExit,
  resizeTerminal,
  writeTerminal,
  type TerminalAttachment,
} from "@/lib/terminal/client";
import { buildXtermFont, buildXtermTheme } from "@/lib/terminal/theme";
import { useTerminalStore } from "@/stores/terminal-store";
import { TerminalSearchOverlay, type SearchController } from "./TerminalSearchOverlay";
import { handleOsc633 } from "@/lib/terminal/osc633";

interface Props {
  tabId: string;
  active: boolean;
}

export function XtermInstance({ tabId, active }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const markExited = useTerminalStore(s => s.markExited);
  const updateCwd = useTerminalStore(s => s.updateCwd);
  const recordCommandStart = useTerminalStore(s => s.recordCommandStart);
  const recordCommandFinish = useTerminalStore(s => s.recordCommandFinish);
  const [searchOpen, setSearchOpen] = useState(false);

  // Stable controller — closes over refs that update across renders.
  const searchController = useMemo<SearchController>(
    () => ({
      findNext: (text, caseSensitive) => {
        searchRef.current?.findNext(text, { caseSensitive });
      },
      findPrevious: (text, caseSensitive) => {
        searchRef.current?.findPrevious(text, { caseSensitive });
      },
      clear: () => {
        termRef.current?.clearSelection();
      },
    }),
    [],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let attachment: TerminalAttachment | null = null;
    let unlistenExit: (() => void) | null = null;
    let onDataDisposer: { dispose: () => void } | null = null;
    let onResizeDisposer: { dispose: () => void } | null = null;
    let oscDisposer: { dispose: () => void } | null = null;
    let webglAddon: WebglAddon | null = null;
    let cancelled = false;

    const font = buildXtermFont();
    const term = new Terminal({
      theme: buildXtermTheme(),
      fontFamily: font.fontFamily,
      fontSize: font.fontSize,
      lineHeight: font.lineHeight,
      allowProposedApi: true,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // WebGL renderer — falls back to canvas/DOM if context creation fails or is lost.
    //
    // addon-webgl and @xterm/xterm move together: 0.19.0 reads
    // `terminal._core._store._isDisposed` on teardown, and that `_store` only
    // exists in the xterm 6.x core — against 5.x the read throws and takes the
    // whole cleanup below with it. They are now on 0.19.x / 6.x respectively;
    // keep them in step, and bump both or neither.
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        webglAddon = null;
      });
      term.loadAddon(addon);
      webglAddon = addon;
    } catch (err) {
      console.warn("[terminal] WebGL renderer unavailable, using fallback", err);
    }

    // Intercept Cmd/Ctrl+F before xterm consumes it.
    if (typeof term.attachCustomKeyEventHandler === "function") {
      term.attachCustomKeyEventHandler(e => {
        if (e.type !== "keydown") return true;
        const mod = e.metaKey || e.ctrlKey;
        if (mod && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
          setSearchOpen(true);
          return false;
        }
        return true;
      });
    }

    // OSC 633 — VS Code shell integration. Parses cwd / command start / command exit.
    if (term.parser?.registerOscHandler) {
      oscDisposer = term.parser.registerOscHandler(633, data => {
        handleOsc633(data, {
          onCwd: cwd => updateCwd(tabId, cwd),
          onCommandStart: cmd => recordCommandStart(tabId, cmd),
          onCommandFinish: exit => recordCommandFinish(tabId, exit),
        });
        return true;
      });
    }

    (async () => {
      try {
        // One ordered stream: the first chunk is the scrollback snapshot
        // (possibly empty), everything after it is live. The backend hands the
        // snapshot over and registers the sink under one lock, so there is no
        // gap for output to fall into and nothing to de-duplicate here.
        let replayed = false;
        const attached = await attachTerminal(tabId, chunk => {
          if (cancelled) return;
          if (chunk.length > 0) term.write(chunk);
          if (replayed) return;
          replayed = true;
          // Force WebGL to paint the current viewport. In some WebView builds
          // the first frame after attach is silently dropped — buffer has the
          // prompt but nothing is drawn until a later keystroke/resize
          // triggers refresh.
          term.write("", () => {
            if (cancelled) return;
            term.refresh(0, term.rows - 1);
          });
        });
        if (cancelled) {
          void attached.detach();
          return;
        }
        attachment = attached;

        unlistenExit = await onTerminalExit(tabId, code => {
          markExited(tabId, code);
        });
        if (cancelled) return;

        const dims = fit.proposeDimensions();
        if (dims) await resizeTerminal(tabId, dims.cols, dims.rows);

        onDataDisposer = term.onData(d => {
          writeTerminal(tabId, new TextEncoder().encode(d)).catch(() => {});
        });
        onResizeDisposer = term.onResize(({ cols, rows }) => {
          resizeTerminal(tabId, cols, rows).catch(() => {});
        });
      } catch (err) {
        console.warn(`[terminal] subscribe failed for ${tabId}`, err);
      }
    })();

    const onWindowResize = () => fit.fit();
    window.addEventListener("resize", onWindowResize);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onWindowResize);
      void attachment?.detach();
      unlistenExit?.();
      onDataDisposer?.dispose();
      onResizeDisposer?.dispose();
      oscDisposer?.dispose();
      // Disposing the addon swaps xterm back to its DOM renderer, and that swap
      // is xterm's code, not ours. When it threw, it took `term.dispose()` and
      // the ref cleanup below with it and leaked the terminal on every unmount.
      try {
        webglAddon?.dispose();
      } catch (err) {
        console.warn("[terminal] WebGL addon teardown failed", err);
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  }, [tabId, markExited, updateCwd, recordCommandStart, recordCommandFinish]);

  useEffect(() => {
    if (active && termRef.current) {
      termRef.current.focus();
      fitRef.current?.fit();
      // Force a repaint when becoming active. Inactive tabs are hidden via
      // the parent's `visibility: hidden`, so their xterm container always
      // has a real size — but WebGL still skips frames while not visible.
      if (typeof termRef.current.refresh === "function") {
        termRef.current.refresh(0, termRef.current.rows - 1);
      }
    }
  }, [active]);

  // Container visibility is owned by the parent (visibility: hidden on
  // inactive tabs). We deliberately do not toggle `display: none` here —
  // `display: none` collapses the container to 0×0, which breaks fit() and
  // leaves the WebGL canvas initialised at zero size for tabs that mount
  // while inactive (e.g. opening a new tab without switching to it first).
  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {searchOpen && (
        <TerminalSearchOverlay
          controller={searchController}
          onClose={() => {
            setSearchOpen(false);
            termRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
