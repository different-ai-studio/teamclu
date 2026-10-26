import * as React from "react"

// Mentioned person type
export interface MentionedPerson {
  id: string
  name: string
  email?: string
}

export type PromptInputMessage = {
  text?: string
  files?: File[]
  mentions?: MentionedPerson[]
}

export type PromptInputContextValue = {
  text: string
  setText: (value: string) => void
  files: File[]
  setFiles: (files: File[] | ((prev: File[]) => File[])) => void
  clearFiles: () => void
  mentions: MentionedPerson[]
  setMentions: React.Dispatch<React.SetStateAction<MentionedPerson[]>>
  clearMentions: () => void
  onSubmit?: (message: PromptInputMessage) => void
  onFilesChange?: (files: File[]) => void
  onMentionTrigger?: (query: string) => void
  onMentionClose?: () => void
  onCommandTrigger?: (query: string) => void
  onCommandClose?: () => void
  onHashTrigger?: (query: string) => void
  onHashClose?: () => void
  multiple?: boolean
  // Ref to editable div for cursor positioning
  textareaRef: React.RefObject<HTMLDivElement | null>
  setTextareaRef: (ref: React.RefObject<HTMLDivElement | null>) => void
  // Ref to track mention start position
  mentionStartRef: React.MutableRefObject<number | null>
  // Ref to track command start position
  commandStartRef: React.MutableRefObject<number | null>
  // Ref to track hash (#) start position
  hashStartRef: React.MutableRefObject<number | null>
  /** Changes when the draft identity changes, so undo does not cross chats. */
  undoScope?: string
}
