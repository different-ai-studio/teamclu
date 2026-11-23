import { describe, expect, it, vi } from "vitest";

import { desktopPathForFile, readDesktopPathsAsFiles } from "@/lib/workspace/read-desktop-files";

vi.mock("@tauri-apps/plugin-fs", () => ({
  stat: vi.fn(async (path: string) => ({
    size: path.includes("big") ? 25 * 1024 * 1024 : 1024,
  })),
  readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

describe("readDesktopPathsAsFiles", () => {
  it("keeps oversize non-image files as local paths without reading bytes", async () => {
    const { stat, readFile } = await import("@tauri-apps/plugin-fs");
    const result = await readDesktopPathsAsFiles([
      "/tmp/big-report.pdf",
      "/tmp/note.txt",
    ]);

    expect(result.local).toEqual([
      { name: "big-report.pdf", size: 25 * 1024 * 1024, path: "/tmp/big-report.pdf" },
    ]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.name).toBe("note.txt");
    expect(desktopPathForFile(result.files[0]!)).toBe("/tmp/note.txt");
    expect(stat).toHaveBeenCalledTimes(2);
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith("/tmp/note.txt");
  });
});
