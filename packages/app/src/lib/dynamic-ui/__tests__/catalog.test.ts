import { describe, expect, it } from "vitest"

describe("dynamic UI catalog", () => {
  it("loads against the installed @json-render/core API", async () => {
    const { getCatalogPrompt, getUiCatalog } = await import("../catalog")

    expect(getCatalogPrompt()).toContain("Card")
    expect(getUiCatalog().data.components.Card.description).toBe("卡片容器，用于分组相关内容")
  })

  it("builds the catalog once and reuses it", async () => {
    const { getUiCatalog, getCatalogPrompt } = await import("../catalog")

    expect(getUiCatalog()).toBe(getUiCatalog())
    expect(getCatalogPrompt()).toBe(getCatalogPrompt())
  })
})
