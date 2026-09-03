import { useEffect, useMemo, useState } from 'react'
import { isChromeExtension } from '@/lib/config/platform'
import { getConfiguredSidePanelDomainPatterns } from '@/lib/extension/side-panel-host-gate-config'
import {
  isSidePanelHostGateEnabled,
  isUrlAllowedBySidePanelPatterns,
  SIDE_PANEL_HOST_GATE_STORAGE_KEY,
  type SidePanelHostGateSnapshot,
} from '@/lib/extension/side-panel-host-allowlist'

type ChromeTabsLike = {
  query: (
    queryInfo: { active?: boolean; lastFocusedWindow?: boolean; currentWindow?: boolean },
  ) => Promise<Array<{ url?: string; active?: boolean; windowId?: number }>>
  onActivated: {
    addListener: (cb: (info: { tabId: number; windowId: number }) => void) => void
    removeListener: (cb: (info: { tabId: number; windowId: number }) => void) => void
  }
  onUpdated: {
    addListener: (
      cb: (
        tabId: number,
        changeInfo: { url?: string; status?: string },
        tab: { active?: boolean; url?: string; windowId?: number },
      ) => void,
    ) => void
    removeListener: (
      cb: (
        tabId: number,
        changeInfo: { url?: string; status?: string },
        tab: { active?: boolean; url?: string; windowId?: number },
      ) => void,
    ) => void
  }
}

type ChromeStorageLike = {
  session?: {
    get: (key: string) => Promise<Record<string, unknown>>
    onChanged?: {
      addListener: (h: (changes: Record<string, { newValue?: unknown }>) => void) => void
      removeListener: (h: (changes: Record<string, { newValue?: unknown }>) => void) => void
    }
  }
}

type ChromeRuntimeLike = {
  onMessage?: {
    addListener: (h: (m: unknown) => void) => void
    removeListener: (h: (m: unknown) => void) => void
  }
}

function readChromeApis(): {
  tabs?: ChromeTabsLike
  storage?: ChromeStorageLike
  runtime?: ChromeRuntimeLike
} {
  return (globalThis as unknown as {
    chrome?: {
      tabs?: ChromeTabsLike
      storage?: ChromeStorageLike
      runtime?: ChromeRuntimeLike
    }
  }).chrome ?? {}
}

function isGateSnapshot(value: unknown): value is SidePanelHostGateSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const v = value as SidePanelHostGateSnapshot
  return typeof v.allowed === 'boolean' && (v.url === null || typeof v.url === 'string')
}

function isGateMessage(m: unknown): m is SidePanelHostGateSnapshot & { type: string } {
  return (
    typeof m === 'object' &&
    m !== null &&
    (m as { type?: unknown }).type === 'side-panel-host-gate' &&
    isGateSnapshot(m)
  )
}

/**
 * When the extension was built with `extensions.domains`, report whether the
 * active tab is allowed. Ungated builds / non-extension → never blocked.
 */
export function useSidePanelHostGate(): {
  gateEnabled: boolean
  blocked: boolean
  url: string | null
} {
  const patterns = useMemo(() => getConfiguredSidePanelDomainPatterns(), [])
  const gateEnabled = isSidePanelHostGateEnabled(patterns) && isChromeExtension()
  const [snapshot, setSnapshot] = useState<SidePanelHostGateSnapshot>({
    allowed: true,
    url: null,
  })

  useEffect(() => {
    if (!gateEnabled) return

    const { tabs, storage, runtime } = readChromeApis()
    let cancelled = false

    const apply = (next: SidePanelHostGateSnapshot) => {
      if (cancelled) return
      setSnapshot(next)
    }

    const evaluateFromTabs = async () => {
      if (!tabs?.query) return
      try {
        const [tab] = await tabs.query({ active: true, lastFocusedWindow: true })
        const url = tab?.url ?? null
        apply({
          allowed: isUrlAllowedBySidePanelPatterns(url, patterns),
          url,
        })
      } catch (e) {
        console.warn('[side-panel-host-gate] tabs.query failed', e)
      }
    }

    const hydrateFromStorage = async () => {
      const session = storage?.session
      if (!session?.get) {
        await evaluateFromTabs()
        return
      }
      try {
        const bag = await session.get(SIDE_PANEL_HOST_GATE_STORAGE_KEY)
        const stored = bag[SIDE_PANEL_HOST_GATE_STORAGE_KEY]
        if (isGateSnapshot(stored)) {
          apply(stored)
          return
        }
      } catch {
        // fall through to tabs
      }
      await evaluateFromTabs()
    }

    void hydrateFromStorage()

    const onActivated = () => {
      void evaluateFromTabs()
    }
    const onUpdated = (
      _tabId: number,
      changeInfo: { url?: string; status?: string },
      tab: { active?: boolean },
    ) => {
      if (!tab.active) return
      if (changeInfo.url == null && changeInfo.status !== 'complete') return
      void evaluateFromTabs()
    }
    const onStorageChanged = (changes: Record<string, { newValue?: unknown }>) => {
      const next = changes[SIDE_PANEL_HOST_GATE_STORAGE_KEY]?.newValue
      if (isGateSnapshot(next)) apply(next)
    }
    const onMessage = (m: unknown) => {
      if (isGateMessage(m)) apply({ allowed: m.allowed, url: m.url })
    }

    tabs?.onActivated?.addListener(onActivated)
    tabs?.onUpdated?.addListener(onUpdated)
    storage?.session?.onChanged?.addListener(onStorageChanged)
    runtime?.onMessage?.addListener(onMessage)

    return () => {
      cancelled = true
      tabs?.onActivated?.removeListener(onActivated)
      tabs?.onUpdated?.removeListener(onUpdated)
      storage?.session?.onChanged?.removeListener(onStorageChanged)
      runtime?.onMessage?.removeListener(onMessage)
    }
  }, [gateEnabled, patterns])

  return {
    gateEnabled,
    blocked: gateEnabled && !snapshot.allowed,
    url: snapshot.url,
  }
}
