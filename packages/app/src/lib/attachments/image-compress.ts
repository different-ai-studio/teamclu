/**
 * image-compress.ts — Downscale/re-encode chat image attachments before upload.
 *
 * Large originals (phone photos, retina screenshots) waste upload bandwidth
 * and are later inlined as base64 into the LLM prompt by the daemon, so every
 * byte here is paid for twice. Cap the longest edge and re-encode lossy; on
 * any decode/encode failure fall back to the original file so upload never
 * breaks because of this optimization. See issue #710.
 */

const MAX_DIMENSION = 2048;
const ENCODE_QUALITY = 0.85;
/** Below this size compression buys little; skip to keep small images lossless. */
const SKIP_BELOW_BYTES = 256 * 1024;

const COMPRESSIBLE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
]);

function replaceExtension(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.${ext}`;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Compress an image file for upload. Returns the original file when the
 * input is not a (re)compressible image, already small, or when compression
 * would not shrink it. Never throws.
 */
export async function compressImageForUpload(file: File): Promise<File> {
  // GIFs may be animated and SVGs are tiny/vector — leave both untouched.
  if (!COMPRESSIBLE_TYPES.has(file.type)) return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  try {
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
    if (scale === 1 && file.size < SKIP_BELOW_BYTES) return file;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    // JPEG has no alpha channel — flatten transparency onto white instead of
    // letting it default to black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    // Prefer WebP; WKWebView (Safari) cannot encode it and silently falls
    // back to PNG in toBlob, so verify the resulting type and retry as JPEG.
    let blob = await canvasToBlob(canvas, "image/webp", ENCODE_QUALITY);
    if (!blob || blob.type !== "image/webp") {
      blob = await canvasToBlob(canvas, "image/jpeg", ENCODE_QUALITY);
      if (!blob || blob.type !== "image/jpeg") return file;
    }
    if (blob.size >= file.size) return file;

    const ext = blob.type === "image/webp" ? "webp" : "jpg";
    return new File([blob], replaceExtension(file.name, ext), {
      type: blob.type,
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}
