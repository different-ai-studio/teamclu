import { beforeEach, describe, expect, it, vi } from "vitest"

const webHandoffUrl = vi.fn<(url: string) => Promise<string | null>>()

vi.mock("@/lib/backend/provider", () => ({
  getBackend: () => ({ auth: { webHandoffUrl } }),
}))

import { consumeWebviewEntryUrl, prepareWebHandoff, resetWebHandoffForTests } from "../web-handoff"

describe("web handoff for link shortcuts", () => {
  beforeEach(() => {
    resetWebHandoffForTests()
    webHandoffUrl.mockReset()
  })

  it("stores the one-time URL for the shortcut and hands it out once", async () => {
    webHandoffUrl.mockResolvedValueOnce("https://admin.mx5.cn/session?redirect=%2Fx#token_hash=h")
    await prepareWebHandoff("https://admin.mx5.cn/x")
    expect(webHandoffUrl).toHaveBeenCalledWith("https://admin.mx5.cn/x")
    expect(consumeWebviewEntryUrl("https://admin.mx5.cn/x")).toBe(
      "https://admin.mx5.cn/session?redirect=%2Fx#token_hash=h",
    )
    expect(consumeWebviewEntryUrl("https://admin.mx5.cn/x")).toBeNull()
  })

  it("asks once per host per run, including hosts the server declines", async () => {
    webHandoffUrl.mockResolvedValue(null)
    await prepareWebHandoff("https://example.com/a")
    await prepareWebHandoff("https://example.com/b")
    expect(webHandoffUrl).toHaveBeenCalledTimes(1)
    expect(consumeWebviewEntryUrl("https://example.com/a")).toBeNull()
  })

  it("collapses concurrent clicks on one host into one request", async () => {
    let resolve!: (v: string | null) => void
    webHandoffUrl.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const a = prepareWebHandoff("https://admin.mx5.cn/x")
    const b = prepareWebHandoff("https://admin.mx5.cn/x")
    resolve("https://admin.mx5.cn/session#token_hash=h")
    await Promise.all([a, b])
    expect(webHandoffUrl).toHaveBeenCalledTimes(1)
  })

  it("retries after a failure and never throws", async () => {
    webHandoffUrl.mockRejectedValueOnce(new Error("offline"))
    await expect(prepareWebHandoff("https://admin.mx5.cn/x")).resolves.toBeUndefined()
    webHandoffUrl.mockResolvedValueOnce(null)
    await prepareWebHandoff("https://admin.mx5.cn/x")
    expect(webHandoffUrl).toHaveBeenCalledTimes(2)
  })

  it("skips non-https links without a request", async () => {
    await prepareWebHandoff("http://admin.mx5.cn/x")
    expect(webHandoffUrl).not.toHaveBeenCalled()
  })
})
