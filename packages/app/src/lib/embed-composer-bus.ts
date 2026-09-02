import type { PageContext } from '@/lib/embed-page-context'
import { useUIStore } from '@/stores/ui'

type InsertHandler = (text: string) => void
const handlers = new Set<InsertHandler>()
/** Append text into the currently mounted chat composer. No-op if none mounted. */
export function emitComposerInsert(text: string): void {
  for (const h of handlers) h(text)
}

export function subscribeComposerInsert(handler: InsertHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

/** Queue a page-link chip insert (store survives composer mount race). */
export function emitPageLinkInsert(ctx: PageContext): void {
  useUIStore.getState().requestPageLinkInsert(ctx)
}

