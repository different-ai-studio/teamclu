import { describe, expect, it } from "vitest";
import { compressImageForUpload } from "@/lib/attachments/image-compress";

function makeFile(name: string, type: string, bytes = 16): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe("compressImageForUpload", () => {
  it("passes through non-compressible types untouched", async () => {
    for (const [name, type] of [
      ["anim.gif", "image/gif"],
      ["icon.svg", "image/svg+xml"],
      ["doc.pdf", "application/pdf"],
    ] as const) {
      const file = makeFile(name, type);
      expect(await compressImageForUpload(file)).toBe(file);
    }
  });

  it("falls back to the original file when decoding fails", async () => {
    // Not a real PNG — createImageBitmap (or its absence in jsdom) must not
    // reject the upload; the original file is returned.
    const file = makeFile("broken.png", "image/png");
    expect(await compressImageForUpload(file)).toBe(file);
  });
});
