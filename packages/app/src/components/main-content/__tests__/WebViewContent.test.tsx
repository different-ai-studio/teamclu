import { act, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebViewContent } from "../WebViewContent"
import { useCurrentTeamStore } from "@/stores/current-team"
import { normalizeUrl, urlToLabel } from "@/lib/ui/webview-utils"

const invokeMock = vi.hoisted(() => vi.fn())

const backendEvents = vi.hoisted(() => new Map<string, Set<(event: unknown) => void>>())

const listenMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}))

/** Fire a backend event at whatever the component has subscribed. */
async function emitBackendEvent(name: string, payload: unknown) {
  await act(async () => {
    for (const handler of backendEvents.get(name) ?? []) handler({ payload })
    await Promise.resolve()
  })
}

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  isTauri: () => true,
}))

describe("WebViewContent", () => {
  beforeEach(() => {
    invokeMock.mockReset()
    backendEvents.clear()
    listenMock.mockReset()
    listenMock.mockImplementation(async (name: string, handler: (event: unknown) => void) => {
      const handlers = backendEvents.get(name) ?? new Set()
      handlers.add(handler)
      backendEvents.set(name, handlers)
      return () => handlers.delete(handler)
    })
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
    // flips on invocation, not on the promise settling. `webview_create` is
    // deliberately absent: a webview is born parked off-window and only
    // `webview_show` puts it in front of the user.
    const state = { shown: false, verdict: { state: "loaded", reason: null as string | null } }
    invokeMock.mockImplementation((command: string) => {
      if (command === "webview_show") state.shown = true
      if (command === "webview_hide" || command === "webview_close") state.shown = false
      if (command === "get_device_hostname") return Promise.resolve("matts-mac")
      if (command === "webview_check_load") return Promise.resolve(state.verdict)
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

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("webview_hide", expect.anything()),
    )
    expect(native.shown).toBe(false)
  })

  it("brings the webview on screen once the page commits, not before", async () => {
    // A WKWebView paints white from the moment it exists, and a native child
    // webview draws above every DOM node — so it is created parked off-window
    // and something has to fetch it. The parking itself is decided in Rust
    // (`add_child` at PARKED_ORIGIN) and is not observable from here; what this
    // covers is the half that lives in this component, the commit that brings
    // it out.
    const native = trackVisibility()
    const label = urlToLabel(normalizeUrl("https://example.test/commits-late"))

    render(<WebViewContent url="https://example.test/commits-late" />)
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("webview_create", expect.anything())
    })
    expect(native.shown).toBe(false)

    await emitBackendEvent("webview-progress", { label, progress: 30 })

    await waitFor(() => expect(native.shown).toBe(true))
  })

  it("explains a failed load instead of leaving a blank webview on screen", async () => {
    // wry fires no event at all for a failed provisional navigation, so the
    // backend rules on it after five seconds. The message is a DOM node and the
    // native webview draws above the DOM, so it has to stay parked.
    const native = trackVisibility()
    const label = urlToLabel(normalizeUrl("https://example.test/dead-host"))

    const view = render(<WebViewContent url="https://example.test/dead-host" />)
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("webview_create", expect.anything())
    })

    await emitBackendEvent("webview-load-verdict", {
      label,
      state: "failed",
      reason: "Host 'localhost' is not reachable",
    })

    await waitFor(() => {
      expect(view.getByText("Host 'localhost' is not reachable")).toBeTruthy()
    })
    expect(native.shown).toBe(false)
  })

  it("shows a slow page anyway rather than accusing it of failing", async () => {
    const native = trackVisibility()
    const label = urlToLabel(normalizeUrl("https://example.test/slow-but-alive"))

    const view = render(<WebViewContent url="https://example.test/slow-but-alive" />)
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("webview_create", expect.anything())
    })

    await emitBackendEvent("webview-load-verdict", { label, state: "slow", reason: null })

    await waitFor(() => expect(native.shown).toBe(true))
    expect(view.queryByText(/not reachable/)).toBeNull()
  })

  it("clears a failure and comes back on screen when the page finally commits", async () => {
    const native = trackVisibility()
    const label = urlToLabel(normalizeUrl("https://example.test/recovers"))

    const view = render(<WebViewContent url="https://example.test/recovers" />)
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("webview_create", expect.anything())
    })

    await emitBackendEvent("webview-load-verdict", {
      label,
      state: "failed",
      reason: "Host 'localhost' is not reachable",
    })
    await waitFor(() => {
      expect(view.getByText("Host 'localhost' is not reachable")).toBeTruthy()
    })

    await emitBackendEvent("webview-progress", { label, progress: 30 })

    await waitFor(() => expect(native.shown).toBe(true))
    expect(view.queryByText("Host 'localhost' is not reachable")).toBeNull()
  })

  it("falls back to its own wording when the backend has no detail to add", async () => {
    // Behind a proxy the backend's probe reaches the proxy, not the origin, so
    // it often has nothing to say beyond "failed" — the message is then ours,
    // and translated.
    const native = trackVisibility()
    const label = urlToLabel(normalizeUrl("https://example.test/no-detail"))

    const view = render(<WebViewContent url="https://example.test/no-detail" />)
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("webview_create", expect.anything())
    })

    await emitBackendEvent("webview-load-verdict", { label, state: "failed", reason: null })

    const { default: i18n } = await import("@/lib/i18n")
    await waitFor(() => {
      expect(view.getByText(i18n.t("webview.loadFailed"))).toBeTruthy()
    })
    expect(native.shown).toBe(false)
  })

  it("does not put a webview that never loaded back on screen when you return to its tab", async () => {
    // The verdict is delivered once, seconds after the webview is created. Come
    // back to the tab later and the frontend has to ask again — showing it on
    // faith is how the blank webview went back up over the app.
    const native = trackVisibility()
    const pageUrl = "https://example.test/still-dead-on-return"

    const first = render(<WebViewContent url={pageUrl} />)
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("webview_create", expect.anything())
    })
    first.unmount()

    // Switching back: the webview exists now, and it is still broken.
    native.verdict = { state: "failed", reason: "Host 'localhost' is not reachable" }
    const second = render(<WebViewContent url={pageUrl} />)

    await waitFor(() => {
      expect(second.getByText("Host 'localhost' is not reachable")).toBeTruthy()
    })
    expect(native.shown).toBe(false)
  })

  it("puts a webview that did load straight back on screen", async () => {
    const native = trackVisibility()
    const pageUrl = "https://example.test/loads-fine-on-return"

    const first = render(<WebViewContent url={pageUrl} />)
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("webview_create", expect.anything())
    })
    first.unmount()

    native.verdict = { state: "loaded", reason: null }
    render(<WebViewContent url={pageUrl} />)

    await waitFor(() => expect(native.shown).toBe(true))
  })

  it("ignores events addressed to a different webview", async () => {
    const native = trackVisibility()

    const view = render(<WebViewContent url="https://example.test/minding-its-business" />)
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("webview_create", expect.anything())
    })

    await emitBackendEvent("webview-load-verdict", {
      label: "wv-some-other-webview",
      state: "failed",
      reason: "Host 'elsewhere' is not reachable",
    })
    await emitBackendEvent("webview-progress", { label: "wv-some-other-webview", progress: 30 })

    expect(native.shown).toBe(false)
    expect(view.queryByText(/not reachable/)).toBeNull()
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
