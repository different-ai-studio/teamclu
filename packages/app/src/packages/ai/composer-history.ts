export const COMPOSER_UNDO_COALESCE_MS = 500
export const COMPOSER_UNDO_LIMIT = 100
/**
 * A keyup or a historyUndo that follows the keydown of the same press.
 * A later keydown is a new press and is not held back by this window.
 */
export const COMPOSER_UNDO_ECHO_MS = 250

export type ComposerEditKind = "type" | "other"

export type ComposerSnapshot = {
  value: string
  caret: number
}

const TYPING_INPUTS = new Set([
  "insertText",
  "insertCompositionText",
  "insertLineBreak",
  "insertParagraph",
  "deleteContentBackward",
  "deleteContentForward",
])

/** Caret sits at the end of the span that changed, in the restored text. */
export function caretAfterReplacement(current: string, restored: string): number {
  let start = 0
  const maxStart = Math.min(current.length, restored.length)
  while (start < maxStart && current[start] === restored[start]) start++
  let endCurrent = current.length
  let endRestored = restored.length
  while (
    endCurrent > start &&
    endRestored > start &&
    current[endCurrent - 1] === restored[endRestored - 1]
  ) {
    endCurrent--
    endRestored--
  }
  return endRestored
}

export function composerEditKind(inputType: string): "type" | "other" | "undo" | "redo" | null {
  if (!inputType) return null
  if (inputType === "historyUndo") return "undo"
  if (inputType === "historyRedo") return "redo"
  if (TYPING_INPUTS.has(inputType)) return "type"
  return "other"
}

/**
 * Cmd/Ctrl+Z as the composer should see it.
 *
 * With a Chinese IME, WebKit often delivers the shortcut as key "Process" or
 * "Unidentified", keyCode 229, and no historyUndo beforeinput. The physical
 * key (`code`) stays KeyZ. Option chords are left alone; keyCode 229 plus
 * altKey is the IME mangling the same shortcut, not Option+Cmd+Z.
 */
export function composerHistoryCommand(event: {
  key?: string
  code?: string
  keyCode?: number
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}): "undo" | "redo" | null {
  if (!event.metaKey && !event.ctrlKey) return null
  if (event.altKey && event.keyCode !== 229) return null
  const key = (event.key ?? "").toLowerCase()
  const code = event.code ?? ""
  const keyCode = event.keyCode ?? 0
  const isZ = key === "z" || code === "KeyZ" || keyCode === 90
  const isY = key === "y" || code === "KeyY" || keyCode === 89
  if (!isZ && !isY) return null
  if (event.shiftKey || (isY && !isZ)) return "redo"
  return "undo"
}

/**
 * Undo stack for the composer.
 *
 * WebKit keeps one typing group for the whole focused contenteditable, and
 * assigning innerHTML never becomes an undo step. Checkpoints split typing
 * after a short pause, and a chip insert or delete is always its own step.
 */
export class ComposerHistory {
  private undoStack: ComposerSnapshot[] = []
  private redoStack: ComposerSnapshot[] = []
  private lastAt = 0
  private lastKind: ComposerEditKind | null = null

  checkpoint(current: ComposerSnapshot, kind: ComposerEditKind, now = Date.now()) {
    const coalesce =
      kind === "type" &&
      this.lastKind === "type" &&
      now - this.lastAt < COMPOSER_UNDO_COALESCE_MS
    this.lastAt = now
    this.lastKind = kind
    if (coalesce) return
    const top = this.undoStack[this.undoStack.length - 1]
    if (top?.value === current.value) return
    this.undoStack.push(current)
    this.redoStack.length = 0
    if (this.undoStack.length > COMPOSER_UNDO_LIMIT) this.undoStack.shift()
  }

  undo(current: ComposerSnapshot): ComposerSnapshot | null {
    while (this.undoStack.length > 0 && this.undoStack[this.undoStack.length - 1]?.value === current.value) {
      this.undoStack.pop()
    }
    const prev = this.undoStack.pop()
    if (!prev) return null
    this.redoStack.push(current)
    this.lastKind = null
    return prev
  }

  redo(current: ComposerSnapshot): ComposerSnapshot | null {
    while (this.redoStack.length > 0 && this.redoStack[this.redoStack.length - 1]?.value === current.value) {
      this.redoStack.pop()
    }
    const next = this.redoStack.pop()
    if (!next) return null
    this.undoStack.push(current)
    this.lastKind = null
    return next
  }

  clear() {
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.lastKind = null
    this.lastAt = 0
  }
}
