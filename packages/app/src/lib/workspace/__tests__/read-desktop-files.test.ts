import { describe, expect, it, vi } from "vitest";

import { readDesktopPathsAsFiles } from "@/lib/workspace/read-desktop-files";

vi.mock("@tauri-apps/plugin-fs", () => ({
  stat: vi.fn(async (path: string) => ({
    size: path.includes("big") ? 25 * 1024 * 1024 : 1024,
  })),
  readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

describe("readDesktopPathsAsFiles", () => {
  it("rejects oversize non-image files before reading bytes", async () => {
    const { stat, readFile } = await import("@tauri-apps/plugin-fs");
    const result = await readDesktopPathsAsFiles([
      "/tmp/big-report.pdf",
      "/tmp/note.txt",
    ]);

    expect(result.oversize).toEqual(["big-report.pdf"]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.name).toBe("note.txt");
    expect(stat).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith("/tmp/note.txt");
  });
});
