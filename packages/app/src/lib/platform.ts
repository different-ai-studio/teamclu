/**
 * Windows applies the update on restart, not before it.
 *
 * macOS swaps the bundle during the install step, so a restart merely picks it
 * up. An NSIS installer cannot patch a running install, so on Windows install
 * can only mean *stage*: the installer runs while the app is closed. Callers
 * that need to know which promise they are making (or whether to warn about a
 * UAC-style prompt before an unattended restart) need this check.
 */
export function isWindowsPlatform(): boolean {
  // Three sources, because the first one is going away: `navigator.platform` is
  // a User-Agent-reduction target and a future WebView2 may freeze or empty it.
  // Getting this wrong is not cosmetic — an emptied value would fall through to
  // the macOS copy, and a Windows user told "the update has been installed"
  // clicks "Restart later" and loses the staged installer.
  const uaPlatform = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData?.platform
  // `startsWith`, not `includes`: platform strings are "Win32" / "Windows", and
  // a substring test matches "darwin" — which is how the first version of this
  // told every macOS user they were on Windows.
  const platforms = [uaPlatform, navigator.platform]
    .filter((p): p is string => !!p)
    .map((p) => p.toLowerCase())
  if (platforms.some((p) => p.startsWith('win'))) return true
  // The UA spells it out in full ("Windows NT 10.0"), so it needs no such care.
  return (navigator.userAgent ?? '').toLowerCase().includes('windows')
}
