/**
 * Image paste handler for Markdown editor.
 * Handles clipboard image detection, _assets directory creation,
 * unique filename generation, image file upload, and path resolution.
 */

import { nanoid } from 'nanoid';
import { isTauri } from '@/lib/utils'


/** Supported image MIME types and their file extensions */
const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Detect image data in clipboard event.
 * Returns the first image File found, or null.
 */
export function detectClipboardImage(event: ClipboardEvent): File | null {
  const items = event.clipboardData?.items;
  if (!items) return null;

  for (const item of items) {
    if (item.kind === 'file' && IMAGE_MIME_TO_EXT[item.type]) {
      return item.getAsFile();
    }
  }
  return null;
}

/**
 * Generate a unique filename for an uploaded image.
 * Format: YYYYMMDD-HHMMSS-{nanoid}.{ext}
 */
function generateImageFilename(mimeType: string): string {
  const ext = IMAGE_MIME_TO_EXT[mimeType] || 'png';
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const id = nanoid(8);
  return `${timestamp}-${id}.${ext}`;
}

/**
 * Get the _assets directory path for a given file path.
 * The _assets directory is at the same level as the markdown file.
 */
function getAssetsDir(filePath: string): string {
  // Use forward slashes for path manipulation, convert back if needed
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const dir = lastSlash >= 0 ? normalized.substring(0, lastSlash) : '.';
  return `${dir}/_assets`;
}

/**
 * Save an image file to the _assets directory and return the relative markdown reference.
 * Returns the markdown image syntax string on success, or null on failure.
 */
type ImageSaveResult =
  | { markdownSyntax: string; absolutePath: string; error?: string }
  | { markdownSyntax?: undefined; absolutePath?: undefined; error: string };

export async function saveClipboardImage(
  imageFile: File,
  filePath: string,
): Promise<ImageSaveResult> {
  if (!isTauri()) {
    return { error: 'Image paste is only supported in Tauri environment' };
  }

  try {
    const { mkdir, writeFile } = await import('@tauri-apps/plugin-fs');

    const assetsDir = getAssetsDir(filePath);
    const filename = generateImageFilename(imageFile.type);
    const imagePath = `${assetsDir}/${filename}`;

    // Create _assets directory if it doesn't exist
    try {
      await mkdir(assetsDir, { recursive: true });
    } catch {
      // Directory may already exist, ignore error
    }

    // Read image file as ArrayBuffer and write to disk
    const buffer = await imageFile.arrayBuffer();
    await writeFile(imagePath, new Uint8Array(buffer));

    // Return markdown syntax with relative path and absolute path for display
    const markdownSyntax = `![](${`_assets/${filename}`})`;
    return { markdownSyntax, absolutePath: imagePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to save image: ${message}` };
  }
}

