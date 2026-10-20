import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { useThreadPanelStore } from "@/stores/thread-panel-store"

vi.mock("../SessionChatColumn", () => ({
  SessionChatColumn: () => <div data-testid="thread-column" />,
}))

vi.mock("../ThreadAnchorPreview", () => ({
  ThreadAnchorPreview: () => null,
}))

import { ThreadPanel } from "../ThreadPanel"

function openPanel() {
  useThreadPanelStore.setState({
    isOpen: true,
    parentSessionId: "parent-1",
    threadSessionId: null,
    rootMessageId: "msg-1",
    title: "回复",
  })
}

describe("ThreadPanel resize", () => {
  beforeEach(() => {
    localStorage.removeItem("teamclu.threadPanelWidth")
    localStorage.setItem("teamclu.threadPanelResizeHintSeen", "1")
    useThreadPanelStore.getState().reset()
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal("cancelAnimationFrame", () => {})
  })

  it("drags wider or narrower, remembers the width, and double-click resets it", () => {
    openPanel()
    const view = render(<ThreadPanel parentSessionId="parent-1" />)
    const shell = screen.getByTestId("thread-panel-shell")
    expect(shell).toHaveStyle({ width: "380px" })

    const handle = screen.getByTestId("thread-panel-resize-handle")
    fireEvent.pointerDown(handle, { clientX: 400, button: 0, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 280, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 280, pointerId: 1 })
    expect(shell).toHaveStyle({ width: "500px" })
    expect(localStorage.getItem("teamclu.threadPanelWidth")).toBe("500")

    fireEvent.pointerDown(handle, { clientX: 200, button: 0, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 500, pointerId: 1 })
    fireEvent.pointerUp(handle, { clientX: 500, pointerId: 1 })
    expect(shell).toHaveStyle({ width: "300px" })

    fireEvent.doubleClick(handle)
    expect(shell).toHaveStyle({ width: "380px" })
    expect(localStorage.getItem("teamclu.threadPanelWidth")).toBe("380")

    const overCap = Math.floor(window.innerWidth * 0.5) + 80
    localStorage.setItem("teamclu.threadPanelWidth", String(overCap))
    view.unmount()
    openPanel()
    render(<ThreadPanel parentSessionId="parent-1" />)
    expect(screen.getByTestId("thread-panel-shell")).toHaveStyle({
      width: `${Math.floor(window.innerWidth * 0.5)}px`,
    })
  })

  it("shows the edge grip once on first open, without moving the panel", async () => {
    localStorage.removeItem("teamclu.threadPanelResizeHintSeen")
    openPanel()
    render(<ThreadPanel parentSessionId="parent-1" />)
    const shell = screen.getByTestId("thread-panel-shell")
    expect(shell).toHaveStyle({ width: "380px" })
    expect(screen.queryByTestId("thread-panel-resize-hint")).not.toBeInTheDocument()

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    expect(screen.getByTestId("thread-panel-resize-hint")).toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(shell).toHaveStyle({ width: "380px" })
    expect(localStorage.getItem("teamclu.threadPanelResizeHintSeen")).toBe("1")
  })

  it("does not show the grip again after it has been seen", async () => {
    openPanel()
    render(<ThreadPanel parentSessionId="parent-1" />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350))
    })
    expect(screen.queryByTestId("thread-panel-resize-hint")).not.toBeInTheDocument()
    expect(screen.getByTestId("thread-panel-shell")).toHaveStyle({ width: "380px" })
  })

  it("resizes from the keyboard", () => {
    openPanel()
    render(<ThreadPanel parentSessionId="parent-1" />)
    const handle = screen.getByTestId("thread-panel-resize-handle")
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    fireEvent.keyUp(handle, { key: "ArrowLeft" })
    expect(screen.getByTestId("thread-panel-shell")).toHaveStyle({ width: "404px" })
    expect(localStorage.getItem("teamclu.threadPanelWidth")).toBe("404")
  })
})
