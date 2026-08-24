import { create } from 'zustand'
import { readTextFile } from '@tauri-apps/plugin-fs'
import { join } from '@tauri-apps/api/path'
import { exists } from '@tauri-apps/plugin-fs'
import { parseContactsMarkdown, type Contact } from '@/lib/contacts'
import { isTauri } from '@/lib/utils'
import { withAsync } from '@/lib/store-utils'


interface ContactsState {
  contacts: Contact[]
  isLoading: boolean
  error: string | null
  
  // Actions
  loadContacts: (workspacePath: string) => Promise<void>
  clearContacts: () => void
}

export const useContactsStore = create<ContactsState>((set) => ({
  contacts: [],
  isLoading: false,
  error: null,
  
  loadContacts: async (workspacePath: string) => {
    if (!isTauri() || !workspacePath) {
      set({ contacts: [], isLoading: false, error: null })
      return
    }

    await withAsync(set, async () => {
      const contactsPath = await join(workspacePath, 'team-knowledge', 'contacts.md')
      const fileExists = await exists(contactsPath)

      if (!fileExists) {
        // No contacts file - return empty array
        set({ contacts: [] })
        return
      }

      const content = await readTextFile(contactsPath)
      const contacts = parseContactsMarkdown(content)

      set({ contacts })
    })
  },
  
  clearContacts: () => {
    set({ contacts: [], isLoading: false, error: null })
  },
}))
