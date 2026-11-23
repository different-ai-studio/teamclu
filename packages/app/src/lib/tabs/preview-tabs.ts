import { useTabsStore } from '@/stores/tabs'
import type { SidebarPreviewKind } from '@/lib/messages/chat-open-target'

/**
 * Read-only previews of chat files (markdown / html), shown as tabs in the
 * content column next to the conversation.
 *
 * The tab carries only a key; the body lives here. `text` is set when the
 * caller already read the file, otherwise the renderer reads `path` itself, so
 * reopening the tab shows the file as it is now.
 */
export interface PreviewTabSource {
  name: string
  kind: SidebarPreviewKind
  path?: string
  text?: string
}

const sources = new Map<string, PreviewTabSource>()

export function previewTabSource(target: string): PreviewTabSource | null {
  return sources.get(target) ?? null
}

/** Open (or refresh and focus) the preview tab for `id`. */
export function openPreviewTab(id: string, source: PreviewTabSource): void {
  sources.set(id, source)
  const store = useTabsStore.getState()
  // openTab only focuses an existing tab; bump it so a refreshed body renders.
  store.openTab({ type: 'preview', target: id, label: source.name })
  store.updateTabMeta(id, { title: source.name })
}
