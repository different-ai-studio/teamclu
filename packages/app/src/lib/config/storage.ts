export function loadFromStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function saveToStorage<T>(key: string, data: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(data))
  } catch {
    // silently swallow quota errors
  }
}

// localStorage is shared across all webview windows of the same Tauri app, so
// keys that belong to per-workspace state (model selection, team-mode model,
// etc.) leak across windows that hold different workspaces. Scoping the key
// with the workspace path keeps each window's state isolated.
//
// `workspacePath` may be null/empty during early startup; in that case the
// key falls back to the unscoped form so existing single-window data still
// loads. Read paths typically also fall back to the unscoped key once when
// the scoped value is absent — see `provider.ts` / `team-mode.ts`.
export function workspaceScopedKey(baseKey: string, workspacePath?: string | null): string {
  const trimmed = workspacePath?.trim()
  if (!trimmed) return baseKey
  return `${baseKey}::${encodeURIComponent(trimmed)}`
}
