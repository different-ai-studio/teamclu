/**
 * Whether `path` is a folder this machine has.
 *
 * Asked of Rust (`path_is_directory`), not the fs plugin's `exists`: that one
 * is scope-gated, and the webview scope only holds folders this run has opened.
 * A window started on an app checkout had never opened the session's own
 * folder, so the check was refused, read as "not here", and the switch skipped.
 * The startup restore used `exists` too, and treated a refusal as "go ahead",
 * so a folder from another machine that had been persisted came back on every
 * launch. See #1579.
 *
 * Errors count as unavailable: every caller uses this to decide whether to
 * adopt (and persist) a path as the window folder, and adopting one we could
 * not check is the failure this guard exists to prevent.
 */
export async function workspacePathAvailableHere(path: string): Promise<boolean> {
  const trimmed = path.trim();
  if (!trimmed) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<boolean>("path_is_directory", { path: trimmed })) === true;
  } catch (error) {
    console.warn("[workspace] could not check workspace path:", error);
    return false;
  }
}
