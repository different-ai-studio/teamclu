import { beforeEach, describe, expect, it } from "vitest"
import {
  THREAD_PANEL_WIDTH_DEFAULT,
  THREAD_PANEL_WIDTH_MIN,
  clampThreadPanelWidth,
  hasSeenThreadPanelResizeHint,
  markThreadPanelResizeHintSeen,
  readThreadPanelWidth,
  resizeThreadPanelWidth,
  threadPanelWidthMax,
  writeThreadPanelWidth,
} from "@/lib/ui/thread-panel-width"

describe("thread panel width", () => {
  beforeEach(() => {
    localStorage.removeItem("teamclu.threadPanelWidth")
    localStorage.removeItem("teamclu.threadPanelResizeHintSeen")
  })

  it("remembers the resize hint only after it has been shown", () => {
    expect(hasSeenThreadPanelResizeHint()).toBe(false)
    markThreadPanelResizeHintSeen()
    expect(hasSeenThreadPanelResizeHint()).toBe(true)
  })

  it("starts at the default width", () => {
    expect(readThreadPanelWidth()).toBe(THREAD_PANEL_WIDTH_DEFAULT)
  })

  it("widens when the pointer moves left and narrows when it moves right", () => {
    expect(resizeThreadPanelWidth(380, -80)).toBe(460)
    expect(resizeThreadPanelWidth(380, 50)).toBe(330)
  })

  it("caps at 50% of the window, and stays inside the chat column", () => {
    expect(resizeThreadPanelWidth(380, 500)).toBe(THREAD_PANEL_WIDTH_MIN)
    expect(threadPanelWidthMax({ windowWidth: 1600 })).toBe(800)
    expect(clampThreadPanelWidth(2000, { windowWidth: 1600 })).toBe(800)
    expect(clampThreadPanelWidth(2000, { windowWidth: 1600, containerWidth: 900 })).toBe(800)
    expect(clampThreadPanelWidth(700, { windowWidth: 0 })).toBe(700)
  })

  it("ignores a stored value that is not a width", () => {
    localStorage.setItem("teamclu.threadPanelWidth", "wide")
    expect(readThreadPanelWidth()).toBe(THREAD_PANEL_WIDTH_DEFAULT)
  })

  it("remembers a width and clamps it to 50% of the window on the way in", () => {
    expect(writeThreadPanelWidth(2000, { windowWidth: 1600 })).toBe(800)
    expect(readThreadPanelWidth({ windowWidth: 1600 })).toBe(800)
    expect(readThreadPanelWidth({ windowWidth: 1600, containerWidth: 800 })).toBe(752)
  })
})
