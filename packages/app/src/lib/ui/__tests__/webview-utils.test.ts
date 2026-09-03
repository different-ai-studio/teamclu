import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "ws-secondary" }),
}));

import { urlToLabel } from "@/lib/ui/webview-utils";

describe("urlToLabel", () => {
  it("scopes native webview labels to the current window", () => {
    expect(urlToLabel("https://example.com")).toContain("ws_secondary");
  });
});
