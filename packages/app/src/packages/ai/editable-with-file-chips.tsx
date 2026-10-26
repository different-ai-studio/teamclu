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
import { caretAfterReplacement, COMPOSER_UNDO_ECHO_MS, ComposerHistory, composerEditKind, composerHistoryCommand, type ComposerEditKind } from "./composer-history"
import { getTrailingPathLabel } from "./chip-labels"
import { setCursorAtPosition } from "./prompt-input-insert-hooks"

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
  /** Drop undo history when the draft identity changes. */
  undoScope?: string
}

export const EditableWithFileChips = React.forwardRef<HTMLDivElement, EditableWithFileChipsProps>(
  ({ value, onChange, onKeyDown, onPaste, onCompositionStart, onCompositionEnd, placeholder, className, disabled, autoFocus, testId, undoScope }, ref) => {
    const editableRef = React.useRef<HTMLDivElement>(null)
    const isUpdatingRef = React.useRef(false)
    const pendingCursorPositionRef = React.useRef<{ node: Node; offset: number } | null>(null)
    const historyRef = React.useRef(new ComposerHistory())
    const historyScopeRef = React.useRef(undoScope)
    const hydratedRef = React.useRef(false)
    const applyingHistoryRef = React.useRef(false)
    const historyWriteRef = React.useRef<string | null>(null)
    const ownedValueRef = React.useRef<string | null>(null)
    const pendingCaretRef = React.useRef<number | null>(null)
    const historyApplyRef = React.useRef(false)
    const suspendCheckpointsRef = React.useRef(false)
    const lastCommittedRef = React.useRef<string | null>(null)
    const modelRef = React.useRef<string | null>(null)
    const echoValueRef = React.useRef<string | null>(null)
    const userEditPendingRef = React.useRef(false)
    const restoringRef = React.useRef(false)
    const acceptInputRef = React.useRef(true)
    const composingRef = React.useRef(false)
    const compositionBaseRef = React.useRef<string | null>(null)
    const compositionCaretRef = React.useRef<number | null>(null)
    const historyShortcutRef = React.useRef(false)
    const historyKeyDownRef = React.useRef(false)
    const undoKeyDownSeenRef = React.useRef(false)
    const lastHistoryCommandAtRef = React.useRef(Number.NEGATIVE_INFINITY)

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

    const readCaretOffset = React.useCallback((element: HTMLElement): number => {
      const serialized = htmlToValue(element)
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return serialized.length
      const range = selection.getRangeAt(0)
      if (!element.contains(range.startContainer)) return serialized.length
      const before = range.cloneRange()
      before.selectNodeContents(element)
      before.setEnd(range.startContainer, range.startOffset)
      const holder = document.createElement("div")
      holder.appendChild(before.cloneContents())
      return htmlToValue(holder).length
    }, [htmlToValue])

    const rememberEdit = React.useCallback((kind: ComposerEditKind) => {
      userEditPendingRef.current = true
      const element = editableRef.current
      if (!element || applyingHistoryRef.current || suspendCheckpointsRef.current) return
      const before = modelRef.current ?? htmlToValue(element)
      historyRef.current.checkpoint(
        { value: before, caret: readCaretOffset(element) },
        kind,
      )
    }, [htmlToValue, readCaretOffset])

    const writeModelDom = React.useCallback((element: HTMLElement, value: string, caret: number) => {
      if (restoringRef.current) return
      restoringRef.current = true
      element.innerHTML = valueToHTML(value)
      setCursorAtPosition(element, caret)
      restoringRef.current = false
    }, [valueToHTML])

    const applySnapshot = React.useCallback((next: { value: string; caret: number } | null) => {
      const element = editableRef.current
      if (!next || !element || historyApplyRef.current) return
      historyApplyRef.current = true
      suspendCheckpointsRef.current = true
      userEditPendingRef.current = false
      compositionBaseRef.current = null
      compositionCaretRef.current = null
      const derived = caretAfterReplacement(modelRef.current ?? htmlToValue(element), next.value)
      // A failed selection during beforeinput stores 0. Trust a caret that
      // actually sits inside the restored text, including a mid-phrase IME.
      const stored = next.caret
      const caret = stored > 0 && stored <= next.value.length ? stored : derived
      pendingCaretRef.current = caret
      modelRef.current = next.value
      historyWriteRef.current = next.value
      ownedValueRef.current = next.value
      lastCommittedRef.current = next.value
      applyingHistoryRef.current = true
      acceptInputRef.current = false
      writeModelDom(element, next.value, caret)
      onChange?.(next.value)
      queueMicrotask(() => {
        historyApplyRef.current = false
        applyingHistoryRef.current = false
      })
      // WebKit can put the previous text back after this event, and then fire
      // input. Keep the model we just applied and write it again if that happens.
      const applied = next.value
      const confirm = () => {
        const latest = editableRef.current
        if (!latest || modelRef.current !== applied) return
        if (htmlToValue(latest) !== applied) writeModelDom(latest, applied, caret)
        else setCursorAtPosition(latest, caret)
      }
      requestAnimationFrame(() => {
        confirm()
        requestAnimationFrame(() => {
          confirm()
          suspendCheckpointsRef.current = false
        })
      })
    }, [htmlToValue, onChange, writeModelDom])

    const historyEchoBlocked = React.useCallback((bypassEcho: boolean) => {
      if (bypassEcho) return false
      return performance.now() - lastHistoryCommandAtRef.current < COMPOSER_UNDO_ECHO_MS
    }, [])

    const performUndo = React.useCallback((bypassEcho = false) => {
      const element = editableRef.current
      if (!element || historyApplyRef.current) return
      if (historyEchoBlocked(bypassEcho)) return
      const current = modelRef.current ?? htmlToValue(element)
      const next = historyRef.current.undo({
        value: current,
        caret: readCaretOffset(element),
      })
      if (!next) return
      lastHistoryCommandAtRef.current = performance.now()
      echoValueRef.current = current
      applySnapshot(next)
    }, [applySnapshot, historyEchoBlocked, htmlToValue, readCaretOffset])

    const performRedo = React.useCallback((bypassEcho = false) => {
      const element = editableRef.current
      if (!element || historyApplyRef.current) return
      if (historyEchoBlocked(bypassEcho)) return
      const current = modelRef.current ?? htmlToValue(element)
      const next = historyRef.current.redo({
        value: current,
        caret: readCaretOffset(element),
      })
      if (!next) return
      lastHistoryCommandAtRef.current = performance.now()
      echoValueRef.current = current
      applySnapshot(next)
    }, [applySnapshot, historyEchoBlocked, htmlToValue, readCaretOffset])

    // Update HTML when value changes. A mismatch here is a chip insert or
    // another edit that replaced the whole string; record the previous text
    // first so undo restores the @ / / # query instead of the earlier sentence.
    React.useEffect(() => {
      if (historyScopeRef.current !== undoScope) {
        historyScopeRef.current = undoScope
        historyRef.current.clear()
        hydratedRef.current = false
        historyWriteRef.current = null
        ownedValueRef.current = null
        modelRef.current = null
        echoValueRef.current = null
        userEditPendingRef.current = false
        compositionBaseRef.current = null
        compositionCaretRef.current = null
      }

      if (!editableRef.current) return

      const nextText = value || ""
      // Undo and redo already wrote the DOM. Touching it again moves the caret
      // to the start and records the text a second time, so the next undo sticks.
      if (historyWriteRef.current === nextText) {
        historyWriteRef.current = null
        ownedValueRef.current = nextText
        lastCommittedRef.current = nextText
        modelRef.current = nextText
        hydratedRef.current = true
        applyingHistoryRef.current = false
        if (htmlToValue(editableRef.current) !== nextText) {
          const caret = pendingCaretRef.current ?? nextText.length
          writeModelDom(editableRef.current, nextText, caret)
        }
        return
      }

      // The IME owns the DOM until the phrase is committed. Adopting the
      // pinyin here is what makes undo walk back through "nl'you'b".
      if (composingRef.current || compositionBaseRef.current != null) {
        hydratedRef.current = true
        return
      }

      if ((isUpdatingRef.current || pendingCursorPositionRef.current) && !applyingHistoryRef.current) {
        return
      }

      const currentText = htmlToValue(editableRef.current)

      if (currentText !== nextText) {
        const applying = applyingHistoryRef.current
        if (hydratedRef.current && !applying && !suspendCheckpointsRef.current) {
          historyRef.current.checkpoint(
            { value: currentText, caret: readCaretOffset(editableRef.current) },
            "other",
          )
        }
        hydratedRef.current = true
        applyingHistoryRef.current = false
        ownedValueRef.current = nextText
        lastCommittedRef.current = nextText
        modelRef.current = nextText
        const caret = applying ? pendingCaretRef.current : null
        pendingCaretRef.current = null
        editableRef.current.innerHTML = valueToHTML(nextText)

        if (caret != null) {
          const node = editableRef.current
          if (node.offsetParent !== null) node.focus()
          setCursorAtPosition(node, caret)
          // WebKit can move the caret to the start when focus settles.
          requestAnimationFrame(() => {
            const latest = editableRef.current
            if (!latest) return
            setCursorAtPosition(latest, caret)
          })
          return
        }

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
      } else {
        hydratedRef.current = true
        applyingHistoryRef.current = false
        pendingCaretRef.current = null
        ownedValueRef.current = nextText
        modelRef.current = nextText
        if (lastCommittedRef.current == null) lastCommittedRef.current = nextText
      }
    }, [value, valueToHTML, htmlToValue, undoScope, readCaretOffset, writeModelDom])

    const commitComposition = React.useCallback((committed: string) => {
      const base = compositionBaseRef.current
      compositionBaseRef.current = null
      if (base != null && base !== committed && !applyingHistoryRef.current) {
        // A committed phrase is its own step. Merging it into the previous
        // phrase is why the first undo removes two segments.
        const caret = compositionCaretRef.current ?? base.length
        compositionCaretRef.current = null
        historyRef.current.checkpoint({ value: base, caret }, "other")
      }
      modelRef.current = committed
      lastCommittedRef.current = committed
      onChange?.(committed)
    }, [onChange])

    const handleInput = React.useCallback((event?: React.FormEvent<HTMLDivElement>) => {
      const element = editableRef.current
      if (!element || restoringRef.current) return

      const newValue = htmlToValue(element)
      const inputType = event ? (event.nativeEvent as InputEvent).inputType : ""
      if (!acceptInputRef.current) {
        const model = modelRef.current
        if (model != null && newValue !== model) {
          writeModelDom(element, model, pendingCaretRef.current ?? model.length)
        }
        return
      }
      const inComposition =
        composingRef.current ||
        inputType === "insertCompositionText" ||
        inputType === "deleteCompositionText" ||
        inputType === "insertFromComposition"
      if (inComposition && (composingRef.current || compositionBaseRef.current == null)) {
        if (compositionBaseRef.current == null) {
          compositionBaseRef.current = modelRef.current ?? lastCommittedRef.current ?? ""
        }
        onChange?.(newValue)
        return
      }
      if (compositionBaseRef.current != null) {
        commitComposition(newValue)
        return
      }
      const model = modelRef.current
      const echo = echoValueRef.current
      const historyEcho =
        !userEditPendingRef.current &&
        echo != null &&
        model != null &&
        newValue !== model &&
        (newValue === echo || newValue.replace(/\n+$/, "") === echo)
      const blocked =
        (applyingHistoryRef.current || suspendCheckpointsRef.current) &&
        !userEditPendingRef.current
      if (blocked || historyEcho) {
        if (model != null && newValue !== model) {
          writeModelDom(element, model, pendingCaretRef.current ?? model.length)
        }
        return
      }

      isUpdatingRef.current = true
      const previous = model ?? lastCommittedRef.current
      if (
        previous != null &&
        previous !== newValue &&
        !applyingHistoryRef.current
      ) {
        historyRef.current.checkpoint(
          { value: previous, caret: readCaretOffset(element) },
          "type",
        )
      }
      if (userEditPendingRef.current || (previous != null && previous !== newValue)) {
        echoValueRef.current = null
      }
      userEditPendingRef.current = false
      modelRef.current = newValue
      lastCommittedRef.current = newValue
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
    }, [commitComposition, htmlToValue, onChange, readCaretOffset, writeModelDom])

    const runHistoryCommand = React.useCallback((command: "undo" | "redo", bypassEcho = false) => {
      historyShortcutRef.current = true
      requestAnimationFrame(() => {
        historyShortcutRef.current = false
      })
      composingRef.current = false
      if (command === "redo") performRedo(bypassEcho)
      else performUndo(bypassEcho)
    }, [performRedo, performUndo])

    const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
      const command = composerHistoryCommand(e.nativeEvent)
      if (command) {
        e.preventDefault()
        e.stopPropagation()
        if (historyKeyDownRef.current || historyApplyRef.current) return
        historyKeyDownRef.current = true
        undoKeyDownSeenRef.current = true
        // This keydown is the press. The echo window only drops the keyup
        // and historyUndo that the IME adds for the same press.
        runHistoryCommand(command, true)
        return
      }
      acceptInputRef.current = true

      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()

        const editable = editableRef.current
        if (editable) {
          rememberEdit("type")
          if (insertLineBreakAtSelection(editable)) handleInput()
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
            rememberEdit("other")
            
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
    }, [handleInput, onKeyDown, rememberEdit, runHistoryCommand])

    React.useEffect(() => {
      const element = editableRef.current
      if (!element) return
      const onBeforeInput = (event: Event) => {
        const inputEvent = event as InputEvent
        const kind = composerEditKind(inputEvent.inputType)
        if (kind === "undo" || kind === "redo") {
          event.preventDefault()
          if (
            !acceptInputRef.current ||
            historyKeyDownRef.current ||
            historyShortcutRef.current ||
            historyApplyRef.current ||
            suspendCheckpointsRef.current
          ) return
          if (kind === "undo") performUndo()
          else performRedo()
          return
        }
        if (!acceptInputRef.current) {
          event.preventDefault()
          return
        }
        if (inputEvent.inputType === "insertLineBreak" || inputEvent.inputType === "insertParagraph") {
          rememberEdit("type")
          return
        }
        const data = inputEvent.data
        if (data && containsControlInput(data)) {
          event.preventDefault()
          return
        }
        if (!kind || composingRef.current) return
        rememberEdit(kind)
      }
      element.addEventListener("beforeinput", onBeforeInput)
      const onWindowHistoryKey = (event: KeyboardEvent) => {
        const editor = editableRef.current
        if (!editor) return
        const target = event.target as Node | null
        const focused = document.activeElement
        const hits =
          target === editor ||
          (!!target && editor.contains(target)) ||
          focused === editor ||
          (!!focused && editor.contains(focused))
        if (!hits) return
        if (event.type === "keyup" && (event.key === "Meta" || event.key === "Control")) {
          undoKeyDownSeenRef.current = false
          historyKeyDownRef.current = false
          return
        }
        const command = composerHistoryCommand(event)
        if (!command) return
        // One physical Cmd+Z. A second keydown before keyup, and a keyup
        // after the keydown already undid, are the same press.
        if (event.type === "keyup") {
          historyKeyDownRef.current = false
          event.preventDefault()
          event.stopPropagation()
          if (undoKeyDownSeenRef.current) return
          if (!historyApplyRef.current) runHistoryCommand(command, false)
          return
        }
        if (historyKeyDownRef.current && !event.repeat) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        historyKeyDownRef.current = true
        undoKeyDownSeenRef.current = true
        event.preventDefault()
        event.stopPropagation()
        if (!historyApplyRef.current) runHistoryCommand(command, true)
      }
      window.addEventListener("keydown", onWindowHistoryKey, true)
      window.addEventListener("keyup", onWindowHistoryKey, true)
      return () => {
        element.removeEventListener("beforeinput", onBeforeInput)
        window.removeEventListener("keydown", onWindowHistoryKey, true)
        window.removeEventListener("keyup", onWindowHistoryKey, true)
      }
    }, [rememberEdit, runHistoryCommand])

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
        onKeyDown={handleKeyDown}
        onCompositionStart={(event) => {
          composingRef.current = true
          if (compositionBaseRef.current == null) {
            const editor = editableRef.current
            compositionBaseRef.current = modelRef.current ?? (editor ? htmlToValue(editor) : "")
            compositionCaretRef.current = editor ? readCaretOffset(editor) : null
          }
          onCompositionStart?.(event)
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false
          onCompositionEnd?.(event)
          requestAnimationFrame(() => {
            const editor = editableRef.current
            if (!editor || compositionBaseRef.current == null) return
            commitComposition(htmlToValue(editor))
          })
        }}
        onPaste={(event) => {
          // Menu paste has no keydown, so the post-undo input lock would drop it.
          acceptInputRef.current = true
          rememberEdit("other")
          onPaste?.(event)
        }}
        onClick={(e) => {
          // Handle chip remove button clicks
          const target = e.target as HTMLElement
          const removeBtn = target.closest('[data-action="remove"]')
          if (removeBtn) {
            e.preventDefault()
            rememberEdit("other")
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
