import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebViewToolbar } from "../WebViewToolbar"

const backend = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, Set<(event: { payload: unknown }) => void>>(),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: backend.invoke }))
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = backend.handlers.get(name) ?? new Set()
    handlers.add(handler)
    backend.handlers.set(name, handlers)
    return () => { handlers.delete(handler) }
  },
}))
vi.mock("@/lib/utils", async (original) => ({
  ...(await original<typeof import("@/lib/utils")>()),
  isTauri: () => true,
}))
vi.mock("@/stores/tabs", () => ({
  useTabsStore: { getState: () => ({ updateTabMeta: () => {} }) },
}))

async function settle() {
  await act(async () => { await vi.dynamicImportSettled() })
}
async function progress(label: string, value = 100) {
  await act(async () => {
    for (const handler of backend.handlers.get("webview-progress") ?? []) {
      handler({ payload: { label, progress: value } })
    }
  })
  await settle()
}

describe("WebViewToolbar address synchronization", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    backend.handlers.clear()
    backend.invoke.mockReset()
    backend.invoke.mockImplementation(async (command: string) => {
      return command === "webview_get_url" ? "https://example.test/current" : ""
    })
  })
  afterEach(async () => {
    await settle()
    cleanup()
    vi.useRealTimers()
  })

  it("reads the existing webview address on mount without waiting for polling", async () => {
    render(<WebViewToolbar url="https://example.test/original" label="first" />)
    await settle()
    expect(screen.getByText("example.test/current")).toBeInTheDocument()
  })

  it("refreshes the address when navigation commits and finishes", async () => {
    let url = "https://example.test/start"
    backend.invoke.mockImplementation(async command => command === "webview_get_url" ? url : "")
    render(<WebViewToolbar url={url} label="first" />)
    await settle()
    url = "https://example.test/next"
    await progress("first", 30)
    expect(screen.getByText("example.test/next")).toBeInTheDocument()
    url = "https://example.test/redirected"
    await progress("first")
    expect(screen.getByText("example.test/redirected")).toBeInTheDocument()
  })

  it("replaces the previous tab address immediately even when the next lookup is pending", async () => {
    const view = render(<WebViewToolbar url="https://example.test/original" label="first" />)
    await settle()
    backend.invoke.mockImplementation(() => new Promise(() => {}))
    view.rerender(<WebViewToolbar url="https://example.test/second" label="second" />)
    expect(screen.getByText("example.test/second")).toBeInTheDocument()
    expect(screen.queryByText("example.test/current")).not.toBeInTheDocument()
  })

  it("updates the URL independently of slow title and favicon lookups", async () => {
    backend.invoke.mockImplementation(command => command === "webview_get_url"
      ? Promise.resolve("https://example.test/current") : new Promise(() => {}))
    render(<WebViewToolbar url="https://example.test/original" label="first" />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByText("example.test/current")).toBeInTheDocument()
  })
  it("catches SPA history changes without waiting for the metadata polling interval", async () => {
    let url = "https://example.test/start"
    backend.invoke.mockImplementation(async command => command === "webview_get_url" ? url : "")
    render(<WebViewToolbar url={url} label="first" />)
    await settle()
    url = "https://example.test/spa-route"
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByText("example.test/spa-route")).toBeInTheDocument()
  })

  it("ignores an older lookup that finishes after a newer navigation", async () => {
    let resolveOld: (url: string) => void = () => {}
    backend.invoke.mockImplementation(command => command === "webview_get_url"
      ? new Promise<string>(resolve => { resolveOld = resolve }) : Promise.resolve(""))
    render(<WebViewToolbar url="https://example.test/start" label="first" />)
    await settle()
    backend.invoke.mockImplementation(async command => command === "webview_get_url"
      ? "https://example.test/newer" : "")
    await progress("first")
    await act(async () => { resolveOld("https://example.test/older") })
    expect(screen.getByText("example.test/newer")).toBeInTheDocument()
  })

  it("ignores an old tab lookup after switching webviews", async () => {
    let resolveOld: (url: string) => void = () => {}
    backend.invoke.mockImplementation(command => command === "webview_get_url"
      ? new Promise<string>(resolve => { resolveOld = resolve }) : Promise.resolve(""))
    const view = render(<WebViewToolbar url="https://example.test/start" label="first" />)
    await settle()
    backend.invoke.mockImplementation(async command => command === "webview_get_url"
      ? "https://example.test/second-current" : "")
    view.rerender(<WebViewToolbar url="https://example.test/second" label="second" />)
    await settle()
    await act(async () => { resolveOld("https://example.test/old-tab") })
    expect(screen.getByText("example.test/second-current")).toBeInTheDocument()
  })

  it("ignores navigation events belonging to another webview", async () => {
    let url = "https://example.test/start"
    backend.invoke.mockImplementation(async command => command === "webview_get_url" ? url : "")
    render(<WebViewToolbar url={url} label="first" />)
    await settle()
    url = "https://example.test/other"
    await progress("second")
    expect(screen.getByText("example.test/start")).toBeInTheDocument()
  })

  it("does not starve URL updates when each IPC lookup is slower than the polling interval", async () => {
    backend.invoke.mockImplementation(command => command === "webview_get_url"
      ? new Promise<string>(resolve => { setTimeout(() => resolve("https://example.test/slow"), 300) })
      : Promise.resolve(""))
    render(<WebViewToolbar url="https://example.test/original" label="first" />)
    await settle()
    await act(async () => { await vi.advanceTimersByTimeAsync(1300) })
    expect(screen.getByText("example.test/slow")).toBeInTheDocument()
  })

})
