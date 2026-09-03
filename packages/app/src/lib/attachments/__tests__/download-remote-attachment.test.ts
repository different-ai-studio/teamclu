import { describe, expect, it, vi, beforeEach } from "vitest";

import { openOrDownloadRemoteAttachment } from "@/lib/attachments/download-remote-attachment";

const revealInFinder = vi.fn(async () => undefined);

vi.mock("@/lib/utils", () => ({
  isTauri: () => false,
}));

vi.mock("@/components/workspace/file-tree-operations", () => ({
  revealInFinder: (...args: unknown[]) => revealInFinder(...args),
}));

describe("openOrDownloadRemoteAttachment", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    revealInFinder.mockClear();
  });

  it("downloads remote bytes via browser anchor", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => bytes.buffer,
      })),
    );

    const click = vi.fn();
    const anchor = {
      href: "",
      download: "",
      click,
    } as unknown as HTMLAnchorElement;
    const createElement = vi.spyOn(document, "createElement").mockReturnValue(anchor);
    const appendChild = vi.spyOn(document.body, "appendChild").mockImplementation(() => anchor);
    const removeChild = vi.spyOn(document.body, "removeChild").mockImplementation(() => anchor);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const result = await openOrDownloadRemoteAttachment(
      "https://cdn.example.test/report.pdf",
      "report.pdf",
    );

    expect(result).toBe("downloaded");
    expect(fetch).toHaveBeenCalledWith("https://cdn.example.test/report.pdf");
    expect(click).toHaveBeenCalledTimes(1);
    expect(revealInFinder).not.toHaveBeenCalled();
    appendChild.mockRestore();
    removeChild.mockRestore();
    createElement.mockRestore();
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });
});
