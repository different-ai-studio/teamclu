import { invoke } from "@tauri-apps/api/core";
import type { AcpDebugLine } from "@/stores/acp-debug-store";
import { isTauri } from "@/lib/utils";

export function formatAcpDebugLine(line: AcpDebugLine): string {
  const ts = new Date(line.ts).toISOString();
  return `[${ts}] ${line.topic} actor=${line.actorId} case=${line.eventCase}\n${JSON.stringify(line.payload, null, 2)}`;
}

/** Block written to disk (matches copy-to-clipboard separators). */
export function formatAcpDebugFileBlock(line: AcpDebugLine): string {
  return `${formatAcpDebugLine(line)}\n\n---\n\n`;
}

export async function appendAcpDebugLineToFile(line: AcpDebugLine): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("acp_debug_append_log", {
      sessionId: line.sessionId,
      text: formatAcpDebugFileBlock(line),
    });
  } catch (e) {
    console.warn("[acp-debug] file append failed", e);
  }
}

export async function getAcpDebugLogDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<string>("acp_debug_log_directory");
  } catch (e) {
    console.warn("[acp-debug] log directory unavailable", e);
    return null;
  }
}

export async function revealAcpDebugLog(sessionId: string | null): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke("acp_debug_reveal_log", {
      sessionId: sessionId?.trim() ? sessionId.trim() : null,
    });
  } catch (e) {
    console.warn("[acp-debug] reveal log failed", e);
  }
}
