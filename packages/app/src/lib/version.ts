import { useState, useEffect } from "react"

const FALLBACK_VERSION = "0.2.3"

let cachedVersion: string | null = null

async function fetchAppVersionInternal(): Promise<string> {
  if (cachedVersion) return cachedVersion

  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    cachedVersion = await getVersion()
    return cachedVersion
  } catch {
    // Not in Tauri environment (e.g. dev browser)
    cachedVersion = FALLBACK_VERSION
    return cachedVersion
  }
}

export async function fetchAppVersion(): Promise<string> {
  return fetchAppVersionInternal()
}

export function useAppVersion(): string {
  const [version, setVersion] = useState(cachedVersion || FALLBACK_VERSION)

  useEffect(() => {
    fetchAppVersionInternal().then(setVersion)
  }, [])

  return version
}
