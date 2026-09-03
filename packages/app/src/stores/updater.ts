import { create } from "zustand"
import { getFeatures } from "@/lib/config/remote-features"
import { isTauri } from "@/lib/utils"

function isUpdaterEnabled(): boolean {
  return getFeatures().updater && !import.meta.env.DEV
}

type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "ready"
  | "error"

interface UpdateInfo {
  state: UpdateState
  version?: string
  notes?: string
  progress?: number
  errorMessage?: string
}

interface PendingUpdate {
  downloadUrl: string
  signature: string
}

interface UpdaterStore {
  update: UpdateInfo
  pendingUpdate: PendingUpdate | null
  setUpdate: (info: UpdateInfo) => void
  checkForUpdates: (silent?: boolean) => Promise<void>
  installUpdate: () => Promise<void>
  retryUpdate: () => Promise<void>
  restart: () => Promise<void>
}

export const useUpdaterStore = create<UpdaterStore>((set, get) => ({
  update: { state: "idle" },
  pendingUpdate: null,

  setUpdate: (info) => set({ update: info }),

  checkForUpdates: async (silent = false) => {
    if (!isTauri()) {
      if (!silent) {
        set({ update: { state: "error", errorMessage: "Updates are only available in the desktop app." } })
      }
      return
    }

    if (!isUpdaterEnabled()) {
      if (!silent) {
        set({
          update: {
            state: "error",
            errorMessage: "Updates are disabled in development builds.",
          },
        })
      }
      return
    }

    set({ update: { state: "checking" } })

    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const result = await invoke<{ version: string; notes: string; downloadUrl: string; signature: string } | null>("check_update")

      if (result) {
        set({
          update: {
            state: "available",
            version: result.version,
            notes: result.notes || "",
          },
          pendingUpdate: {
            downloadUrl: result.downloadUrl,
            signature: result.signature,
          },
        })
        // Download and install in the background; UI only prompts when ready to restart (or on error).
        await get().installUpdate()
      } else {
        set({ update: { state: "up-to-date" }, pendingUpdate: null })
        // Auto-clear after 3s
        setTimeout(() => {
          const current = get().update
          if (current.state === "up-to-date") {
            set({ update: { state: "idle" } })
          }
        }, 3000)
      }
    } catch (err) {
      if (silent) {
        console.warn("[Updater] Check failed (silent):", err)
        set({ update: { state: "idle" } })
      } else {
        console.error("[Updater] Check failed:", err)
        set({ update: { state: "error", errorMessage: String(err) } })
      }
    }
  },

  installUpdate: async () => {
    if (!isUpdaterEnabled()) {
      set({
        update: {
          state: "error",
          errorMessage: "Updates are disabled in development builds.",
        },
      })
      return
    }

    const pending = get().pendingUpdate
    if (!pending) {
      const cur = get().update
      set({
        update: { ...cur, state: "error", errorMessage: "No pending update to install." },
      })
      return
    }

    const base = get().update
    set({ update: { ...base, state: "downloading", progress: 0 } })

    try {
      const { invoke } = await import("@tauri-apps/api/core")
      const { listen } = await import("@tauri-apps/api/event")

      // Listen for download progress events from Rust
      const unlisten = await listen<{ downloaded: number; contentLength: number | null }>(
        "update-download-progress",
        (event) => {
          const { downloaded, contentLength } = event.payload
          const cur = get().update
          if (contentLength && contentLength > 0) {
            set({
              update: {
                ...cur,
                state: "downloading",
                progress: Math.round((downloaded / contentLength) * 100),
              },
            })
          } else {
            set({ update: { ...cur, state: "downloading" } })
          }
        },
      )

      try {
        await invoke("download_and_install_update", {
          downloadUrl: pending.downloadUrl,
          signature: pending.signature,
        })
        const cur = get().update
        set({
          update: { ...cur, state: "ready", progress: undefined, errorMessage: undefined },
          pendingUpdate: null,
        })
      } finally {
        unlisten()
      }
    } catch (err) {
      console.error("[Updater] Install failed:", err)
      const cur = get().update
      set({
        update: {
          ...cur,
          state: "error",
          errorMessage: String(err),
        },
      })
    }
  },

  retryUpdate: async () => {
    // Re-run the full check + download flow
    set({ update: { state: "idle" }, pendingUpdate: null })
    await get().checkForUpdates(false)
  },

  restart: async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("restart_app")
      // `restart_app` exits the process; if we are still alive a moment later
      // the relaunch never took, so tell the user instead of leaving the
      // dialog looking like the click did nothing.
      setTimeout(() => {
        const cur = get().update
        if (cur.state === "ready") {
          set({
            update: {
              ...cur,
              state: "error",
              errorMessage: "Failed to restart. Please quit and reopen the app manually.",
            },
          })
        }
      }, 5000)
    } catch (err) {
      console.error("[Updater] Relaunch failed:", err)
      set({
        update: {
          state: "error",
          errorMessage: `Failed to restart: ${String(err)}. Please restart manually.`,
        },
      })
    }
  },
}))
