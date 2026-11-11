import { isMacPlatform, isWindowsPlatform } from '@/lib/platform'

import { formatShortcut } from '@/lib/platform-shortcuts'

type LabelT = (
  key: string,
  fallback: string,
  opts?: Record<string, string>,
) => string

/** Native file-manager action: Finder / Explorer / generic. */
export function revealInFileManagerLabel(t: LabelT): string {
  if (isMacPlatform()) {
    return t('fileExplorer.revealInFinder', 'Reveal in Finder')
  }
  if (isWindowsPlatform()) {
    return t('fileExplorer.revealInExplorer', 'Show in Explorer')
  }
  return t('fileExplorer.revealInFileManager', 'Show in file manager')
}

export function openLogInFileManagerLabel(t: LabelT): string {
  if (isMacPlatform()) {
    return t('chat.acpDebug.openLogInFinder', 'Open log in Finder')
  }
  if (isWindowsPlatform()) {
    return t('chat.acpDebug.openLogInExplorer', 'Open log in Explorer')
  }
  return t('chat.acpDebug.openLogInFileManager', 'Open log in file manager')
}

export function revealAcpLogLabel(t: LabelT): string {
  if (isMacPlatform()) {
    return t('sessions.detail.revealAcpLogMac', 'Reveal ACP log in Finder')
  }
  if (isWindowsPlatform()) {
    return t('sessions.detail.revealAcpLogExplorer', 'Reveal ACP log in Explorer')
  }
  return t('sessions.detail.revealAcpLogFileManager', 'Reveal ACP log in file manager')
}

export function skillsAccessRevealLabel(t: LabelT): string {
  return revealInFileManagerLabel(t)
}

export function skillsAccessOsPermissionBody(t: LabelT, path: string): string {
  if (isMacPlatform()) {
    return t(
      'skills.access.osPermissionBodyMac',
      'Your user account cannot read or write {{path}}. In Finder, select the folder → Get Info → Sharing & Permissions, fix ownership, then retry.',
      { path },
    )
  }
  if (isWindowsPlatform()) {
    return t(
      'skills.access.osPermissionBodyWindows',
      'Your user account cannot read or write {{path}}. In File Explorer, right-click the folder → Properties → Security, fix permissions, then retry.',
      { path },
    )
  }
  return t(
    'skills.access.osPermissionBodyLinux',
    'Your user account cannot read or write {{path}}. Fix folder permissions in your file manager, then retry.',
    { path },
  )
}

export function skillsAccessTauriScopeBody(t: LabelT, path: string): string {
  if (isMacPlatform()) {
    return t(
      'skills.access.tauriScopeBodyMac',
      'The app does not have filesystem access to {{path}}. Click Retry to re-authorize, or open the folder in Finder.',
      { path },
    )
  }
  if (isWindowsPlatform()) {
    return t(
      'skills.access.tauriScopeBodyWindows',
      'The app does not have filesystem access to {{path}}. Click Retry to re-authorize, or open the folder in File Explorer.',
      { path },
    )
  }
  return t(
    'skills.access.tauriScopeBodyLinux',
    'The app does not have filesystem access to {{path}}. Click Retry to re-authorize, or open the folder in your file manager.',
    { path },
  )
}

export function closeWindowQuitHint(t: LabelT): string {
  const quitKeys = formatShortcut('mod+Q')
  if (isMacPlatform()) {
    return t(
      'settings.general.closeWindowDescMac',
      'Choose what happens when you click the window close button. {{quitKeys}} always quits and stops the agent.',
      { quitKeys },
    )
  }
  return t(
    'settings.general.closeWindowDescOther',
    'Choose what happens when you click the window close button. {{quitKeys}} always quits and stops the agent.',
    { quitKeys },
  )
}

export function sidebarSearchWithShortcutLabel(t: LabelT): string {
  return t('sidebar.searchWithShortcutDynamic', 'Search ({{shortcut}})', {
    shortcut: formatShortcut('mod+K'),
  })
}
