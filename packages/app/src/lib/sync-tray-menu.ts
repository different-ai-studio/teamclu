import i18n from '@/lib/i18n'
import { isTauri } from '@/lib/utils'

/**
 * The native menu bar has no OS-supplied translations to fall back on — muda
 * pins every predefined item to English — so Rust needs the full label set, not
 * just the ones we added ourselves. Fallbacks mirror `menu.*` in `zh-CN.json`.
 *
 * `&` marks the Windows Alt-key mnemonic; macOS strips it. CJK spells it as a
 * trailing `(&X)` group, which Rust drops on macOS.
 */
function appMenuLabels() {
  return {
    file: i18n.t('menu.file', '文件(&F)'),
    edit: i18n.t('menu.edit', '编辑(&E)'),
    view: i18n.t('menu.view', '视图(&V)'),
    window: i18n.t('menu.window', '窗口(&W)'),
    help: i18n.t('menu.help', '帮助(&H)'),
    settings: i18n.t('menu.settings', '设置…'),
    undo: i18n.t('menu.undo', '撤销'),
    redo: i18n.t('menu.redo', '重做'),
    cut: i18n.t('menu.cut', '剪切'),
    copy: i18n.t('menu.copy', '复制'),
    paste: i18n.t('menu.paste', '粘贴'),
    selectAll: i18n.t('menu.selectAll', '全选'),
    minimize: i18n.t('menu.minimize', '最小化'),
    maximize: i18n.t('menu.maximize', '最大化'),
    zoom: i18n.t('menu.zoom', '缩放'),
    fullscreen: i18n.t('menu.fullscreen', '切换全屏'),
    close: i18n.t('menu.close', '关闭'),
    closeWindow: i18n.t('menu.closeWindow', '关闭窗口'),
    about: i18n.t('menu.about', '关于'),
    hide: i18n.t('menu.hide', '隐藏'),
    hideOthers: i18n.t('menu.hideOthers', '隐藏其他'),
    services: i18n.t('menu.services', '服务'),
    quit: i18n.t('menu.quit', '退出'),
  }
}

/** Push current i18n strings into native tray + app menu bar. */
export async function syncTrayMenuLabels(): Promise<void> {
  if (!isTauri()) return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('update_tray_menu_labels', {
      showMain: i18n.t('tray.showMain', '打开主窗口'),
      agentSettings: i18n.t('tray.agentSettings', '本地 Agent 设置…'),
      quit: i18n.t('tray.quitAndStopAgent', '退出并停止 Agent'),
    })
    await invoke('update_app_menu_labels', { labels: appMenuLabels() })
  } catch {
    // Tray / app menu may be unavailable in web / early boot — ignore.
  }
}
