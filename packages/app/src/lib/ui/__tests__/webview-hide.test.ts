import { describe, expect, it, vi } from "vitest"
import { hideNativeWebview } from "@/lib/ui/webview-hide"

const LABEL = "wv-main-http___localhost_9000_manage"

describe("hideNativeWebview", () => {
  it("hides and leaves the webview alive when the hide answers", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    expect(await hideNativeWebview(invoke, LABEL, 50)).toBe("hidden")
    expect(invoke).toHaveBeenCalledWith("webview_hide", { label: LABEL })
    // The page, its scroll and its login survive for the next open.
    expect(invoke).not.toHaveBeenCalledWith("webview_close", expect.anything())
  })

  it("counts a refused hide as answered", async () => {
    // "No such label" is the command running and saying no — quite different
    // from a command that never returns, and nothing is left on screen.
    const invoke = vi.fn().mockRejectedValue(new Error("no webview"))
    expect(await hideNativeWebview(invoke, LABEL, 50)).toBe("hidden")
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it("closes the webview when the hide never comes back", async () => {
    // The field failure: the command starts, logs, and produces nothing more.
    // Left alone, the webview stays painted over whatever comes next.
    const invoke = vi.fn().mockImplementation((command: string) =>
      command === "webview_hide" ? new Promise(() => {}) : Promise.resolve(),
    )
    expect(await hideNativeWebview(invoke, LABEL, 20)).toBe("closed")
    expect(invoke).toHaveBeenCalledWith("webview_close", { label: LABEL })
  })

  it("reports the case where neither way out works", async () => {
    const invoke = vi.fn().mockImplementation((command: string) =>
      command === "webview_hide" ? new Promise(() => {}) : Promise.reject(new Error("gone")),
    )
    expect(await hideNativeWebview(invoke, LABEL, 20)).toBe("stuck")
  })

  it("does not keep a timer alive after a prompt hide", async () => {
    // A stray 1.5s timer per tab switch would keep the event loop awake for no
    // reason; the deadline is cancelled as soon as the hide answers.
    const clear = vi.spyOn(globalThis, "clearTimeout")
    const invoke = vi.fn().mockResolvedValue(undefined)
    await hideNativeWebview(invoke, LABEL, 10_000)
    expect(clear).toHaveBeenCalled()
    clear.mockRestore()
  })
})
