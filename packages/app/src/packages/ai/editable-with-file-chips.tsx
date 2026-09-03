import * as React from "react"
import { cn } from "@/lib/utils"
import { encodeMemberMentionToken, parseMemberMentionBody } from "@/lib/actor/member-mention-token"
import {
  encodePageLinkToken,
  pageLinkChipLabel,
  parsePageLinkBody,
} from "@/lib/embed/page-link-token"
import {
  encodeSessionAttachmentToken,
  parseSessionAttachmentBody,
} from "@/lib/attachments/session-attachment-token"
import { COMPOSER_CHIP_SELECTOR, isComposerChipElement } from "./chip-classes"
import { getTrailingPathLabel } from "./chip-labels"

function parseSlashToken(body: string): { type: 'role' | 'skill' | 'command'; name: string } {
  if (body.startsWith('role:')) return { type: 'role', name: body.slice('role:'.length) }
  if (body.startsWith('skill:')) return { type: 'skill', name: body.slice('skill:'.length) }
  if (body.startsWith('command:')) return { type: 'command', name: body.slice('command:'.length) }
  return { type: 'skill', name: body }
}

const COMPOSER_CHIP_BASE =
  "composer-chip inline-flex items-center gap-1 h-[22px] pl-[9px] pr-[9px] mx-0.5 rounded-md text-xs font-medium leading-none align-middle whitespace-nowrap"

const CHIP_REMOVE =
  `<span class="composer-chip-remove-slot" contenteditable="false">` +
  `<span class="chip-remove cursor-pointer rounded-full hover:bg-black/5 dark:hover:bg-white/10 inline-flex shrink-0 items-center justify-center" style="width:14px;height:14px;" data-action="remove">` +
  `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>` +
  `</span></span>`

function containsControlInput(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f || code === 0xfffd) return true
  }
  return false
}

function hasNativeTrailingLineBreakPlaceholder(element: HTMLElement): boolean {
  const lastChild = element.lastChild
  const previousChild = lastChild?.previousSibling
  return (
    lastChild?.nodeType === Node.TEXT_NODE &&
    lastChild.textContent === "\n" &&
    previousChild !== null
  )
}

function insertLineBreakAtSelection(editable: HTMLElement): boolean {
  if (typeof document.execCommand === "function" && document.execCommand("insertLineBreak")) {
    return true
  }

  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return false

  const range = selection.getRangeAt(0)
  if (!editable.contains(range.commonAncestorContainer)) return false

  selection.deleteFromDocument()
  const textNode = document.createTextNode("\n")
  range.insertNode(textNode)
  range.setStartAfter(textNode)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

interface EditableWithFileChipsProps {
  value?: string
  onChange?: (value: string) => void
  onKeyDown?: (event: React.KeyboardEvent) => void
  onPaste?: (event: React.ClipboardEvent) => void
  onCompositionStart?: (event: React.CompositionEvent) => void
  onCompositionEnd?: (event: React.CompositionEvent) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  autoFocus?: boolean
  testId?: string
}

export const EditableWithFileChips = React.forwardRef<HTMLDivElement, EditableWithFileChipsProps>(
  ({ value, onChange, onKeyDown, onPaste, onCompositionStart, onCompositionEnd, placeholder, className, disabled, autoFocus, testId }, ref) => {
    const editableRef = React.useRef<HTMLDivElement>(null)
    const isUpdatingRef = React.useRef(false)
    const pendingCursorPositionRef = React.useRef<{ node: Node; offset: number } | null>(null)

    React.useImperativeHandle(ref, () => editableRef.current!)

    // Convert @{filepath} and unified /{...} slash tokens to HTML with chips
    const valueToHTML = React.useCallback((text: string): string => {
      if (!text) return ""
      
      const parts: string[] = []
      // Match @{filepath}, /{...}, and legacy /[...] /<...> tokens
      const regex = /(@\{([^}]+)\})|(\/\{([^}]+)\})|(\/\[([^\]]+)\])|(\/<([a-z0-9]+(?:-[a-z0-9]+)*)>)/g
      let lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = regex.exec(text)) !== null) {
        // Add text before match
        if (match.index > lastIndex) {
          const textPart = text.slice(lastIndex, match.index)
          parts.push(escapeHTML(textPart))
        }
        
        if (match[1]) {
          const atBody = match[2]
          const member = parseMemberMentionBody(atBody)
          if (member) {
            parts.push(
              `<span class="member-chip composer-chip human-mention-inline inline-flex items-center min-h-[22px] py-px pl-0.5 pr-0.5 mx-0.5 text-xs font-medium leading-snug align-middle text-[#5a6270] dark:text-[#b8c5d0] whitespace-nowrap" contenteditable="false" data-memberid="${escapeHTML(member.id)}" data-membername="${escapeHTML(member.name)}" style="vertical-align: middle;">` +
              `<span class="text-faint">@</span>` +
              `<span class="max-w-[200px] truncate">${escapeHTML(member.name)}</span>` +
              CHIP_REMOVE +
              `</span>`,
            )
          } else {
          const page = parsePageLinkBody(atBody)
          if (page) {
            const token = encodePageLinkToken(page)
            const label = pageLinkChipLabel(page)
            parts.push(
              `<span class="page-link-chip ${COMPOSER_CHIP_BASE} bg-[#f5efe8] text-[#6b5a48] dark:bg-[#2e2922] dark:text-[#d3c5ac]" contenteditable="false" data-pagelinktoken="${escapeHTML(token)}" style="vertical-align: middle;">` +
              `<svg class="lucide lucide-link shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>` +
              `<span class="max-w-[320px] truncate">${escapeHTML(label)}</span>` +
              CHIP_REMOVE +
              `</span>`,
            )
          } else {
          const sessionAttachment = parseSessionAttachmentBody(atBody)
          if (sessionAttachment) {
            const token = encodeSessionAttachmentToken(sessionAttachment)
            const icon = sessionAttachment.isImage
              ? `<svg class="lucide lucide-image shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`
              : `<svg class="lucide lucide-file-text shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`
            parts.push(
              `<span class="session-attachment-chip ${COMPOSER_CHIP_BASE} border border-dashed border-[rgba(26,26,20,0.18)] bg-[#f7f6f3] text-[#5a6270] dark:border-[rgba(255,255,255,0.15)] dark:bg-[#252420] dark:text-[#b8c5d0]" contenteditable="false" data-sessionattachmenttoken="${escapeHTML(token)}" style="vertical-align: middle;">` +
              icon +
              `<span class="max-w-[320px] truncate">${escapeHTML(sessionAttachment.name)}</span>` +
              `<span class="text-faint text-[10px] leading-none">#</span>` +
              CHIP_REMOVE +
              `</span>`,
            )
          } else {
          // @{filepath} - workspace file chip (solid blue)
          const filePath = atBody
          const fileLabel = getTrailingPathLabel(filePath)
          parts.push(
            `<span class="file-chip ${COMPOSER_CHIP_BASE} bg-[#edf2f7] text-[#5a7086] dark:bg-[#202a34] dark:text-[#aec3d6]" contenteditable="false" data-filepath="${escapeHTML(filePath)}" style="vertical-align: middle;">` +
            `<svg class="lucide lucide-file-text shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>` +
            `<span class="max-w-[320px] truncate">${escapeHTML(fileLabel)}</span>` +
            CHIP_REMOVE +
            `</span>`
          )
          }
          }
          }
        } else if (match[3]) {
          const parsed = parseSlashToken(match[4])
          if (parsed.type === 'role') {
            parts.push(
              `<span class="role-chip ${COMPOSER_CHIP_BASE} bg-[#eef3f5] text-[#5b7080] dark:bg-[#222d33] dark:text-[#b8cad3]" contenteditable="false" data-rolename="${escapeHTML(parsed.name)}" style="vertical-align: middle;">` +
              `<svg class="lucide lucide-user-round shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>` +
              `<span class="max-w-[400px] truncate">${escapeHTML(parsed.name)}</span>` +
              CHIP_REMOVE +
              `</span>`
            )
          } else if (parsed.type === 'command') {
            parts.push(
              `<span class="command-chip ${COMPOSER_CHIP_BASE} bg-[#f1ebf3] text-[#75607c] dark:bg-[#2f2632] dark:text-[#ccbcd2]" contenteditable="false" data-commandname="${escapeHTML(parsed.name)}" style="vertical-align: middle;">` +
              `<svg class="lucide lucide-command shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/></svg>` +
              `<span class="max-w-[400px] truncate">${escapeHTML(parsed.name)}</span>` +
              CHIP_REMOVE +
              `</span>`
            )
          } else {
            parts.push(
              `<span class="skill-chip ${COMPOSER_CHIP_BASE} bg-[#f3efe6] text-[#7a6a52] dark:bg-[#302b22] dark:text-[#d3c5ac]" contenteditable="false" data-skillname="${escapeHTML(parsed.name)}" style="vertical-align: middle;">` +
              `<svg class="lucide lucide-zap shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>` +
              `<span class="max-w-[400px] truncate">${escapeHTML(parsed.name)}</span>` +
              CHIP_REMOVE +
              `</span>`
            )
          }
        } else if (match[5]) {
          // /[commandname] - command chip (purple)
          const commandName = match[6]
          parts.push(
            `<span class="command-chip ${COMPOSER_CHIP_BASE} bg-[#f1ebf3] text-[#75607c] dark:bg-[#2f2632] dark:text-[#ccbcd2]" contenteditable="false" data-commandname="${escapeHTML(commandName)}" style="vertical-align: middle;">` +
            `<svg class="lucide lucide-command shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/></svg>` +
            `<span class="max-w-[400px] truncate">${escapeHTML(commandName)}</span>` +
            CHIP_REMOVE +
            `</span>`
          )
        } else if (match[7]) {
          // /<role-name> - role chip (sky)
          const roleName = match[8]
          parts.push(
            `<span class="role-chip ${COMPOSER_CHIP_BASE} bg-[#eef3f5] text-[#5b7080] dark:bg-[#222d33] dark:text-[#b8cad3]" contenteditable="false" data-rolename="${escapeHTML(roleName)}" style="vertical-align: middle;">` +
            `<svg class="lucide lucide-user-round shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/></svg>` +
            `<span class="max-w-[400px] truncate">${escapeHTML(roleName)}</span>` +
            CHIP_REMOVE +
            `</span>`
          )
        }
        
        lastIndex = match.index + match[0].length
      }

      // Add remaining text
      if (lastIndex < text.length) {
        parts.push(escapeHTML(text.slice(lastIndex)))
      }

      return parts.join("")
    }, [])

    // Convert HTML back to @{filepath} and unified /{...} slash tokens
    const htmlToValue = React.useCallback((element: HTMLElement): string => {
      let result = ""
      
      const traverse = (node: Node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          result += node.textContent || ""
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement
          if (el.classList.contains("file-chip")) {
            const filepath = el.getAttribute("data-filepath") || ""
            result += `@{${filepath}}`
          } else if (el.classList.contains("session-attachment-chip")) {
            const token = el.getAttribute("data-sessionattachmenttoken") || ""
            if (token) result += token
          } else if (el.classList.contains("member-chip")) {
            const memberId = el.getAttribute("data-memberid") || ""
            const memberName = el.getAttribute("data-membername") || ""
            if (memberId && memberName) {
              result += encodeMemberMentionToken({ id: memberId, name: memberName })
            }
          } else if (el.classList.contains("page-link-chip")) {
            const token = el.getAttribute("data-pagelinktoken") || ""
            if (token) result += token
          } else if (el.classList.contains("role-chip")) {
            const rolename = el.getAttribute("data-rolename") || ""
            result += `/{role:${rolename}}`
          } else if (el.classList.contains("skill-chip")) {
            const skillname = el.getAttribute("data-skillname") || ""
            result += `/{skill:${skillname}}`
          } else if (el.classList.contains("command-chip")) {
            const commandname = el.getAttribute("data-commandname") || ""
            result += `/{command:${commandname}}`
          } else if (el.tagName === "BR") {
            result += "\n"
          } else if (el.tagName === "DIV") {
            // Contenteditable creates divs for new lines
            if (result && !result.endsWith("\n")) {
              result += "\n"
            }
            el.childNodes.forEach(traverse)
          } else {
            el.childNodes.forEach(traverse)
          }
        }
      }

      element.childNodes.forEach(traverse)
      if (result.endsWith("\n") && hasNativeTrailingLineBreakPlaceholder(element)) {
        result = result.slice(0, -1)
      }
      return result
    }, [])

    // Update HTML when value changes
    React.useEffect(() => {
      // Skip if we're in the middle of updating or have pending cursor position
      if (!editableRef.current || isUpdatingRef.current || pendingCursorPositionRef.current) {
        return
      }
      
      const currentText = htmlToValue(editableRef.current)
      
      if (currentText !== (value || "")) {
        const html = valueToHTML(value || "")
        editableRef.current.innerHTML = html || ""
        
        // Restore cursor to end and focus when content was updated externally
        // Guard: skip focus if element is hidden (e.g. inside display:none parent)
        if (editableRef.current.offsetParent !== null) {
          editableRef.current.focus()
          const range = document.createRange()
          const sel = window.getSelection()
          if (editableRef.current.childNodes.length > 0) {
            const lastNode = editableRef.current.childNodes[editableRef.current.childNodes.length - 1]
            range.setStartAfter(lastNode)
            range.collapse(true)
            sel?.removeAllRanges()
            sel?.addRange(range)
          }
        }
      }
    }, [value, valueToHTML, htmlToValue])

    const handleInput = React.useCallback(() => {
      if (!editableRef.current) return

      isUpdatingRef.current = true
      const newValue = htmlToValue(editableRef.current)
      onChange?.(newValue)
      
      // Use requestAnimationFrame to ensure cursor is set after all DOM updates
      requestAnimationFrame(() => {
        if (pendingCursorPositionRef.current) {
          const { node, offset } = pendingCursorPositionRef.current
          const range = document.createRange()
          const sel = window.getSelection()
          
          try {
            // Check if node is still in the document
            if (document.contains(node)) {
              range.setStart(node, offset)
              range.collapse(true)
              sel?.removeAllRanges()
              sel?.addRange(range)
            }
          } catch (err) {
            console.warn("Failed to restore cursor:", err)
          }
          
          pendingCursorPositionRef.current = null
        }
        
        isUpdatingRef.current = false
      })
    }, [htmlToValue, onChange])

    const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()

        const editable = editableRef.current
        if (editable && insertLineBreakAtSelection(editable)) {
          handleInput()
        }
        return
      }

      // Delete chip with Backspace
      if (e.key === "Backspace") {
        const sel = window.getSelection()
        
        if (sel && sel.rangeCount > 0 && sel.isCollapsed) {
          const range = sel.getRangeAt(0)
          const container = range.startContainer
          const offset = range.startOffset
          
          let chipToDelete: HTMLElement | null = null
          
          // If cursor is inside a chip (shouldn't happen due to contenteditable="false", but just in case)
          let node = container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement
          while (node && node !== editableRef.current) {
            if (isComposerChipElement(node as HTMLElement)) {
              chipToDelete = node as HTMLElement
              break
            }
            node = node.parentElement
          }
          
          // Check if we're right after a chip
          if (!chipToDelete && container.nodeType === Node.ELEMENT_NODE) {
            const element = container as HTMLElement
            
            if (offset > 0) {
              const prevNode = element.childNodes[offset - 1]

              // Case A: caret is directly after a chip node.
              if (prevNode && isComposerChipElement(prevNode as HTMLElement)) {
                chipToDelete = prevNode as HTMLElement
              }

              // Case B: caret is after a whitespace text node that follows a chip:
              // [chip][" "]|  -> one Backspace should remove chip (and trailing space).
              if (!chipToDelete && prevNode?.nodeType === Node.TEXT_NODE) {
                const prevText = prevNode.textContent || ""
                if (prevText.trim() === "") {
                  const maybeChip = prevNode.previousSibling as HTMLElement | null
                  if (isComposerChipElement(maybeChip)) {
                    chipToDelete = maybeChip
                  }
                }
              }
            }
          } else if (!chipToDelete && container.nodeType === Node.TEXT_NODE) {
            const textNode = container as Text
            const textContent = textNode.textContent || ""
            
            // Check if we're at the start of a text node, OR if the text before cursor is only whitespace
            if (offset === 0 || textContent.slice(0, offset).trim() === "") {
              // At the start of a text node or only whitespace before cursor, check previous sibling
              const prevSibling = container.previousSibling
              
              if (prevSibling && prevSibling.nodeType === Node.ELEMENT_NODE) {
                if (isComposerChipElement(prevSibling as HTMLElement)) {
                  chipToDelete = prevSibling as HTMLElement
                }
              } else if (prevSibling?.nodeType === Node.TEXT_NODE) {
                const prevText = prevSibling.textContent || ""
                if (prevText.trim() === "") {
                  const maybeChip = prevSibling.previousSibling as HTMLElement | null
                  if (isComposerChipElement(maybeChip)) {
                    chipToDelete = maybeChip
                  }
                }
              }
            }
          }
          
          // If we found a chip to delete
          if (chipToDelete) {
            e.preventDefault()
            e.stopPropagation()
            
            // CRITICAL: Record position info BEFORE deleting
            const parent = chipToDelete.parentNode as HTMLElement
            let nextSibling = chipToDelete.nextSibling
            
            // Delete the chip
            chipToDelete.remove()
            
            // Also delete trailing space if the next sibling is a text node starting with space
            if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
              const textContent = nextSibling.textContent || ''
              if (textContent.startsWith(' ')) {
                nextSibling.textContent = textContent.slice(1)
                // If the text node is now empty, remove it
                if (!nextSibling.textContent) {
                  const temp = nextSibling.nextSibling
                  nextSibling.remove()
                  nextSibling = temp
                }
              }
            }
            
            // Determine target cursor position.
            // For backspace chip deletion, always keep caret on the right side
            // of the removed chip (same position the user expects to keep typing).
            // eslint-disable-next-line no-useless-assignment
            let targetNode: Node | null = null
            // eslint-disable-next-line no-useless-assignment
            let targetOffset = 0
            
            // Strategy 1: If next sibling is a text node, place cursor at its beginning
            if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
              targetNode = nextSibling
              targetOffset = 0
            }
            // Strategy 2: Create a new text node exactly where the chip was
            else {
              const textNode = document.createTextNode('')
              
              // Check if nextSibling is an empty BR or empty DIV (contenteditable auto-creates these)
              if (nextSibling && nextSibling.nodeType === Node.ELEMENT_NODE) {
                const nextEl = nextSibling as HTMLElement
                if (nextEl.tagName === 'BR' || 
                    (nextEl.tagName === 'DIV' && !nextEl.textContent?.trim())) {
                  nextSibling.remove()
                  parent.appendChild(textNode)
                } else {
                  parent.insertBefore(textNode, nextSibling)
                }
              } else if (nextSibling) {
                parent.insertBefore(textNode, nextSibling)
              } else {
                parent.appendChild(textNode)
              }
              
              targetNode = textNode
              targetOffset = 0
            }
            
            // Store cursor position for later restoration
            if (targetNode) {
              pendingCursorPositionRef.current = { node: targetNode, offset: targetOffset }
            }
            
            // Trigger input event to update state (cursor will be set in handleInput via requestAnimationFrame)
            handleInput()
            
            return
          }
        }
      }
      
      onKeyDown?.(e)
    }, [handleInput, onKeyDown])

    const handleBeforeInput = React.useCallback((e: React.FormEvent<HTMLDivElement>) => {
      const inputEvent = e.nativeEvent as InputEvent;
      if (inputEvent.inputType === "insertLineBreak" || inputEvent.inputType === "insertParagraph") return;

      const data = inputEvent.data;
      if (!data) return;
      // Some desktop/webview input methods can surface arrow-key escape bytes as
      // insertText. Text editing keys should move the caret, never mutate content.
      if (containsControlInput(data)) {
        e.preventDefault();
      }
    }, [])

    React.useEffect(() => {
      if (autoFocus && editableRef.current) {
        editableRef.current.focus()
      }
    }, [autoFocus])

    return (
      <div
        ref={editableRef}
        contentEditable={!disabled}
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-gramm="false"
        data-gramm_editor="false"
        data-enable-grammarly="false"
        data-testid={testId}
        onInput={handleInput}
        onBeforeInput={handleBeforeInput}
        onKeyDown={handleKeyDown}
        onClick={(e) => {
          // Handle chip remove button clicks
          const target = e.target as HTMLElement
          const removeBtn = target.closest('[data-action="remove"]')
          if (removeBtn) {
            e.preventDefault()
            const chip = removeBtn.closest(COMPOSER_CHIP_SELECTOR)
            if (chip) {
              const chipEl = chip as HTMLElement
              const parent = chipEl.parentNode as HTMLElement | null
              let nextSibling = chipEl.nextSibling

              // Keep spacing behavior consistent with backspace chip deletion.
              if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
                const textContent = nextSibling.textContent || ''
                if (textContent.startsWith(' ')) {
                  nextSibling.textContent = textContent.slice(1)
                  if (!nextSibling.textContent) {
                    const temp = nextSibling.nextSibling
                    nextSibling.remove()
                    nextSibling = temp
                  }
                }
              }

              // Remove chip first, then restore cursor on its right side.
              chip.remove()

              if (parent) {
                let targetNode: Node

                if (nextSibling && nextSibling.nodeType === Node.TEXT_NODE) {
                  targetNode = nextSibling
                } else {
                  const textNode = document.createTextNode('')
                  if (nextSibling) {
                    parent.insertBefore(textNode, nextSibling)
                  } else {
                    parent.appendChild(textNode)
                  }
                  targetNode = textNode
                }

                pendingCursorPositionRef.current = { node: targetNode, offset: 0 }
              }

              // Trigger input event to sync value
              handleInput()
            }
          }
        }}
        onPaste={onPaste}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onDrop={(e) => {
          // Prevent contentEditable from handling drops natively (inserting text).
          // Let the event bubble to the parent form's onDrop handler instead.
          e.preventDefault()
        }}
        onDragOver={(e) => {
          e.preventDefault()
        }}
        className={cn(
          "min-h-[36px] max-h-[200px] overflow-y-auto resize-none border-0 bg-transparent px-0 py-0.5 text-sm leading-normal outline-none",
          "empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground empty:before:pointer-events-none",
          className
        )}
        data-placeholder={placeholder}
        suppressContentEditableWarning
        style={{
          whiteSpace: "pre-wrap",
          wordWrap: "break-word",
          overflowWrap: "anywhere",
        }}
      />
    )
  }
)

EditableWithFileChips.displayName = "EditableWithFileChips"

function escapeHTML(str: string): string {
  const div = document.createElement("div")
  div.textContent = str
  return div.innerHTML
}
