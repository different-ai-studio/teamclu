import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type TerminalStatus = "running" | "exited";

interface OpenResult {
  id: string;
  shell: string;
  pid: number;
}

interface SubscribeResult {
  /** Handed back to `terminal_detach` when the view goes away. */
  sink_id: number;
  cols: number;
  rows: number;
  status: TerminalStatus;
  exit_code: number | null;
}

/** A live attachment to a terminal's output. */
export interface TerminalAttachment extends SubscribeResult {
  /** Stop receiving output. Idempotent; errors are swallowed. */
  detach(): Promise<void>;
}

interface TerminalSummary {
  id: string;
  shell: string;
  pid: number;
  status: TerminalStatus;
  exit_code: number | null;
}

interface OpenParams {
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  shell?: string;
  allowedRoots: string[];
}

export async function openTerminal(p: OpenParams): Promise<OpenResult> {
  return invoke<OpenResult>("terminal_open", {
    workspaceId: p.workspaceId,
    cwd: p.cwd,
    cols: p.cols,
    rows: p.rows,
    shell: p.shell,
    allowedRoots: p.allowedRoots,
  });
}

/**
 * Attach to a terminal's output stream.
 *
 * Output arrives over a Tauri IPC channel as raw bytes — an `ArrayBuffer` per
 * PTY read — instead of the `terminal://<id>/data` event it used to be, whose
 * payload was a JSON `number[]` (three to four bytes of text per byte, parsed
 * on the main thread, delivered to every window). The channel is ordered and
 * scoped to this webview.
 *
 * The first chunk is the scrollback snapshot (possibly empty), taken under the
 * same lock that registers the sink, so every later chunk is strictly after it.
 * That is what let the old snapshot → subscribe → re-snapshot → de-duplicate
 * sequence go: replay and live output are one stream now.
 */
export async function attachTerminal(
  id: string,
  onData: (chunk: Uint8Array) => void,
): Promise<TerminalAttachment> {
  const channel = new Channel<ArrayBuffer | Uint8Array>();
  channel.onmessage = (message) => {
    onData(message instanceof Uint8Array ? message : new Uint8Array(message));
  };
  const result = await invoke<SubscribeResult>("terminal_subscribe", { id, onData: channel });
  let detached = false;
  return {
    ...result,
    detach: async () => {
      if (detached) return;
      detached = true;
      await invoke("terminal_detach", { id, sinkId: result.sink_id }).catch(() => {});
    },
  };
}

export async function writeTerminal(id: string, data: Uint8Array): Promise<void> {
  // Raw-body IPC: Tauri 2 lets us pass the Uint8Array straight through as the
  // request body, skipping the per-byte JSON encoding that `Array.from()` +
  // default invoke serialisation would otherwise cost on every keystroke. The
  // backend reads the terminal id from the request header instead of args.
  await invoke("terminal_write", data, { headers: { "x-terminal-id": id } });
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  await invoke("terminal_resize", { id, cols, rows });
}

export async function closeTerminal(id: string): Promise<void> {
  await invoke("terminal_close", { id });
}

export async function listTerminals(workspaceId?: string): Promise<TerminalSummary[]> {
  return invoke<TerminalSummary[]>("terminal_list", { workspaceId });
}

export async function onTerminalExit(
  id: string,
  cb: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<number | null>(`terminal://${id}/exit`, e => {
    cb(e.payload);
  });
}
