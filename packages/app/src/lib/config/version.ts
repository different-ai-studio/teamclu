import { useState, useEffect } from "react"

const FALLBACK_VERSION = "0.2.3"

let cachedVersion: string | null = null

function readExtensionManifestVersion(): string | null {
  try {
    const chrome = (globalThis as {
      chrome?: { runtime?: { getManifest?: () => { version?: string } } }
    }).chrome
    const version = chrome?.runtime?.getManifest?.()?.version
    return version && version.trim() ? version : null
  } catch {
    return null
  }
}

function immediateVersion(): string {
  return cachedVersion ?? readExtensionManifestVersion() ?? FALLBACK_VERSION
}

async function fetchAppVersionInternal(): Promise<string> {
  if (cachedVersion) return cachedVersion

  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    cachedVersion = await getVersion()
    return cachedVersion
  } catch {
    // Not in Tauri: prefer the loaded extension manifest so the side-panel
    // footer matches the packaged version instead of a stale fallback.
  }

  const extensionVersion = readExtensionManifestVersion()
  if (extensionVersion) {
    cachedVersion = extensionVersion
    return cachedVersion
  }

  cachedVersion = FALLBACK_VERSION
  return cachedVersion
}

export async function fetchAppVersion(): Promise<string> {
  return fetchAppVersionInternal()
}

/** Test-only: drop the memo so a later case can observe a different source. */
export function resetAppVersionCacheForTests(): void {
  cachedVersion = null
}

export function useAppVersion(): string {
  const [version, setVersion] = useState(immediateVersion)

  useEffect(() => {
    fetchAppVersionInternal().then(setVersion)
  }, [])

  return version
}
