import { render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebViewContent } from "../WebViewContent"
import { useCurrentTeamStore } from "@/stores/current-team"

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  isTauri: () => true,
}))

describe("WebViewContent", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    vi.stubGlobal("ResizeObserver", vi.fn().mockImplementation(function () {
      return {
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      }
    }))
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => {},
    })
    useCurrentTeamStore.setState({ currentMember: null })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("uses team member display name from cloud profile when available", async () => {
    useCurrentTeamStore.setState({
      currentMember: { id: "member-1", displayName: "Matt", role: "owner", joinedAt: null },
    })
    invokeMock.mockImplementation((command: string) => {
      if (command === "webview_set_bounds") return Promise.resolve()
      if (command === "get_device_hostname") return Promise.resolve("matts-mac")
      if (command === "webview_create") return Promise.resolve()
      if (command === "webview_hide") return Promise.resolve()
      throw new Error(`unexpected command: ${command}`)
    })

    render(<WebViewContent url="https://example.test/team-member-name" />)

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "webview_create",
        expect.objectContaining({
          deviceNo: undefined,
          deviceName: "Matt",
        }),
      )
    })
    // The deleted get_persistent_device_id command must not be invoked.
    expect(invokeMock).not.toHaveBeenCalledWith("get_persistent_device_id")
  })

  it("falls back to device hostname when team member name is unavailable", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "webview_set_bounds") return Promise.resolve()
      if (command === "get_device_hostname") return Promise.resolve("matts-mac")
      if (command === "webview_create") return Promise.resolve()
      if (command === "webview_hide") return Promise.resolve()
      throw new Error(`unexpected command: ${command}`)
    })

    render(<WebViewContent url="https://example.test/device-name" />)

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "webview_create",
        expect.objectContaining({
          deviceNo: undefined,
          deviceName: "matts-mac",
        }),
      )
    })
  })

  it("omits deviceNo entirely outside team mode", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "webview_set_bounds") return Promise.resolve()
      if (command === "get_device_hostname") return Promise.resolve("standalone-mac")
      if (command === "webview_create") return Promise.resolve()
      if (command === "webview_hide") return Promise.resolve()
      throw new Error(`unexpected command: ${command}`)
    })

    render(<WebViewContent url="https://example.test/standalone-name" />)

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "webview_create",
        expect.objectContaining({
          deviceNo: undefined,
          deviceName: "standalone-mac",
        }),
      )
    })
  })

  /**
   * What the user sees, modelled: a native webview is either on screen or it
   * is not. Counting invocations cannot tell a leftover webview from a busy
   * one — this can.
   */
  function trackVisibility(pending: Record<string, Promise<void>> = {}) {
    // Commands take effect natively in the order they are invoked, so the flag
    // flips on invocation, not on the promise settling.
    const state = { shown: false }
    invokeMock.mockImplementation((command: string) => {
      if (command === "webview_create" || command === "webview_show") state.shown = true
      if (command === "webview_hide" || command === "webview_close") state.shown = false
      if (command === "get_device_hostname") return Promise.resolve("matts-mac")
      return pending[command] ?? Promise.resolve()
    })
    return state
  }

  it("does not leave a webview on screen when creation lands after the switch away", async () => {
    // The white rectangle over the session pane: switching views while the
    // native webview was still being created ran the cleanup too early — the
    // webview did not exist yet, so there was nothing to hide — and the create
    // then finished with nobody left to hide it. A native webview left showing
    // sits on top of whatever the user switched to, for the rest of the run.
    let finishCreate = () => {}
    const creating = new Promise<void>((resolve) => {
      finishCreate = resolve
    })
    const native = trackVisibility({ webview_create: creating })

    const view = render(<WebViewContent url="https://example.test/slow-create" />)
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("webview_create", expect.anything())
    })

    view.unmount()
    finishCreate()

    await waitFor(() => expect(native.shown).toBe(false))
  })

  it("still creates the webview when get_device_hostname fails (does not gate on name)", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "webview_set_bounds") return Promise.resolve()
      if (command === "get_device_hostname") return Promise.reject(new Error("hostname failed"))
      if (command === "webview_create") return Promise.resolve()
      if (command === "webview_hide") return Promise.resolve()
      throw new Error(`unexpected command: ${command}`)
    })

    render(<WebViewContent url="https://example.test/no-hostname" />)

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "webview_create",
        expect.objectContaining({
          deviceNo: undefined,
          deviceName: "",
        }),
      )
    })
  })
})
