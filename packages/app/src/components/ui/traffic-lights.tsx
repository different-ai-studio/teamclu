import { isTauri } from "@/lib/utils"
import { isMacPlatform } from "@/lib/platform"

/**
 * Spacer that reserves space for the native macOS traffic lights
 * when using titleBarStyle: "overlay". Only macOS gets that title bar
 * (tauri.macos.conf.json); Windows and Linux keep a native one above the
 * page, so there the spacer would just be a blank gap.
 */
export function TrafficLights() {
  if (!isTauri() || !isMacPlatform()) {
    return null
  }

  return <div className="w-[68px] shrink-0 ml-[5px]" data-tauri-drag-region />
}
