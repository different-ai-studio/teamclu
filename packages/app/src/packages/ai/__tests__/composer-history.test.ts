import { describe, expect, it } from "vitest"
import { caretAfterReplacement, ComposerHistory, composerHistoryCommand } from "../composer-history"

describe("ComposerHistory", () => {
  it("coalesces typing inside the pause window and splits after it", () => {
    const history = new ComposerHistory()
    history.checkpoint({ value: "", caret: 0 }, "type", 1_000)
    history.checkpoint({ value: "H", caret: 1 }, "type", 1_200)
    history.checkpoint({ value: "Hello", caret: 5 }, "type", 1_400)
    expect(history.undo({ value: "Hello there", caret: 11 })?.value).toBe("")

    history.checkpoint({ value: "Hello", caret: 5 }, "type", 2_000)
    history.checkpoint({ value: "Hello ", caret: 6 }, "type", 2_100)
    expect(history.undo({ value: "Hello there", caret: 11 })?.value).toBe("Hello")
  })

  it("records a chip replacement as its own step", () => {
    const history = new ComposerHistory()
    history.checkpoint({ value: "", caret: 0 }, "type", 1_000)
    history.checkpoint({ value: "Hi @qu", caret: 6 }, "other", 1_100)
    expect(history.undo({ value: "Hi @{src/a.ts} ", caret: 15 })?.value).toBe("Hi @qu")
    expect(history.undo({ value: "Hi @qu", caret: 6 })?.value).toBe("")
  })

  it("puts the caret at the end of the undone burst", () => {
    expect(caretAfterReplacement("12312阿城萨克啊实打实", "12312阿城萨克")).toBe("12312阿城萨克".length)
    expect(caretAfterReplacement("abcd", "abXcd")).toBe(3)
    expect(caretAfterReplacement("abXcd", "abcd")).toBe(2)
  })

  it("skips a repeated snapshot so the next undo still reaches earlier text", () => {
    const history = new ComposerHistory()
    history.checkpoint({ value: "", caret: 0 }, "type", 1_000)
    history.checkpoint({ value: "Hello", caret: 5 }, "type", 2_000)
    expect(history.undo({ value: "Hello there", caret: 11 })?.value).toBe("Hello")
    history.checkpoint({ value: "Hello", caret: 5 }, "other", 2_100)
    expect(history.undo({ value: "Hello", caret: 5 })?.value).toBe("")
  })

  it("redo restores the undone snapshot and a new edit clears redo", () => {
    const history = new ComposerHistory()
    history.checkpoint({ value: "", caret: 0 }, "type", 1_000)
    expect(history.undo({ value: "Hello", caret: 5 })?.value).toBe("")
    expect(history.redo({ value: "", caret: 0 })?.value).toBe("Hello")
    history.checkpoint({ value: "", caret: 0 }, "type", 2_000)
    expect(history.redo({ value: "X", caret: 1 })).toBeNull()
  })

  it("treats an IME-mangled Cmd+Z as undo and ignores the Command key itself", () => {
    expect(composerHistoryCommand({
      key: "Process",
      code: "KeyZ",
      keyCode: 229,
      metaKey: true,
      altKey: true,
    })).toBe("undo")
    expect(composerHistoryCommand({
      key: "Unidentified",
      code: "KeyZ",
      keyCode: 229,
      metaKey: true,
    })).toBe("undo")
    expect(composerHistoryCommand({
      key: "Meta",
      code: "MetaLeft",
      keyCode: 229,
      metaKey: true,
    })).toBeNull()
    expect(composerHistoryCommand({
      key: "Alt",
      code: "AltLeft",
      keyCode: 229,
    })).toBeNull()
    expect(composerHistoryCommand({
      key: "z",
      code: "KeyZ",
      metaKey: true,
      shiftKey: true,
    })).toBe("redo")
  })
})
