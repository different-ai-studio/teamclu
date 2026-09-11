import { create } from 'zustand'
import {
  discardKnowledgeCandidate,
  listKnowledgeInbox,
} from '@/lib/knowledge/inbox-client'
import type { KnowledgeCandidate } from '@/lib/knowledge/inbox-types'

type KnowledgeInboxState = {
  items: KnowledgeCandidate[]
  loading: boolean
  error: string | null
  load: () => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useKnowledgeInboxStore = create<KnowledgeInboxState>((set, get) => ({
  items: [],
  loading: false,
  error: null,
  load: async () => {
    if (get().loading) return
    set({ loading: true, error: null })
    try {
      const items = await listKnowledgeInbox()
      set({ items, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
  remove: async (id) => {
    await discardKnowledgeCandidate(id)
    set({ items: get().items.filter((item) => item.id !== id) })
  },
}))
