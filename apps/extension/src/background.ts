import { fetchActivePageContext } from './lib/page-fetch'
import { isOpenSidePanel, isRequestPage } from './lib/messages'
import { isBrowserToolMessage } from './lib/browser-tools/messages'
import { handleBrowserToolMessage } from './lib/browser-tools/handle-browser-tool'
import { openSidePanelFromUserGesture } from './lib/open-side-panel'
import { startSidePanelHostGate } from './lib/side-panel-host-gate'
import {
  chromeDynamicContentScriptDeps,
  syncLinkHoverContentScript,
} from './lib/dynamic-content-script'
import { LINK_HOVER_CONFIG_KEY, readLinkHoverConfig } from '@teamclu/extension-link-hover'

const SIDE_PANEL_PATH = 'sidepanel/index.html'

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[bg] setPanelBehavior failed', e))

/**
 * Global (window-scoped) panel only.
 * Never call setOptions({ tabId, path }) — Chrome treats that as a *second*
 * sidepanel/index.html instance when path matches side_panel.default_path.
 */
async function ensureGlobalSidePanel(): Promise<void> {
  try {
    await chrome.sidePanel.setOptions({
      path: SIDE_PANEL_PATH,
      enabled: true,
    })
  } catch (e) {
    console.warn('[bg] ensureGlobalSidePanel failed', e)
  }
}

async function injectContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
    })
  } catch (e) {
    // Without activeTab or a granted host permission for this page Chrome
    // refuses the injection. Say so instead of letting the follow-up
    // sendMessage fail with an opaque "Receiving end does not exist".
    console.warn('[bg] inject content-script failed', tabId, e)
    throw new Error('page_access_not_granted')
  }
}

// No install-time injection into open tabs: the content script reaches a page
// only (a) through a user/agent page request the user approved, via
// scripting.executeScript on the active tab, or (b) on link-hover domains the
// user allow-listed and granted host access for (registered below).
async function syncLinkHover(): Promise<void> {
  try {
    await syncLinkHoverContentScript(
      chromeDynamicContentScriptDeps(async () => (await readLinkHoverConfig()).domains),
    )
  } catch (e) {
    console.warn('[bg] link-hover content script sync failed', e)
  }
}

async function bootstrapSidePanel(): Promise<void> {
  await ensureGlobalSidePanel()
  await syncLinkHover()
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && LINK_HOVER_CONFIG_KEY in changes) void syncLinkHover()
})
chrome.permissions.onAdded.addListener(() => void syncLinkHover())
chrome.permissions.onRemoved.addListener(() => void syncLinkHover())

chrome.runtime.onInstalled.addListener(() => {
  void bootstrapSidePanel()
})

chrome.runtime.onStartup.addListener(() => {
  void bootstrapSidePanel()
})

// Domain-gated builds: publish active-tab allow state (overlay in panel, no close).
startSidePanelHostGate()

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (isOpenSidePanel(msg)) {
    const windowId = sender.tab?.windowId
    if (windowId == null) {
      sendResponse({ ok: false, error: 'no-window' })
      return true
    }

    void openSidePanelFromUserGesture(msg, windowId).then(sendResponse)
    return true
  }

  if (isBrowserToolMessage(msg)) {
    void (async () => {
      try {
        const result = await handleBrowserToolMessage(msg, {
          injectContentScript,
          sendToTab: async (tabId, payload) => {
            await injectContentScript(tabId)
            return chrome.tabs.sendMessage(tabId, payload)
          },
          updateTabUrl: async (tabId, url) => {
            await chrome.tabs.update(tabId, { url })
          },
        })
        sendResponse(result)
      } catch (e) {
        sendResponse({ error: e instanceof Error ? e.message : String(e) })
      }
    })()
    return true
  }

  if (!isRequestPage(msg)) return undefined

  void (async () => {
    try {
      const ctx = await fetchActivePageContext({
        queryActiveTabId: async () => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
          return tab?.id ?? null
        },
        sendToTab: async (tabId, m) => {
          await injectContentScript(tabId)
          return chrome.tabs.sendMessage(tabId, m)
        },
      })
      sendResponse(ctx ?? { type: 'page-context', error: 'unavailable' })
    } catch (e) {
      sendResponse({ type: 'page-context', error: e instanceof Error ? e.message : String(e) })
    }
  })()
  return true
})
