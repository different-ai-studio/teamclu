/**
 * avatar-image.ts — Turn a picked image file into the square JPEG we store as a
 * member's avatar.
 *
 * Avatars render at 96px at most, so a phone photo is center-cropped to a square
 * and scaled to AVATAR_SIZE before upload. The output is always JPEG: every
 * webview can encode it (WKWebView cannot encode WebP) and it is one of the
 * types the `avatars` bucket accepts.
 */

export const AVATAR_SOURCE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const AVATAR_MAX_SOURCE_BYTES = 20 * 1024 * 1024
const AVATAR_SIZE = 512
const ENCODE_QUALITY = 0.9

export type AvatarImageErrorCode = 'unsupported_type' | 'too_large' | 'decode_failed'

export class AvatarImageError extends Error {
  readonly code: AvatarImageErrorCode

  constructor(code: AvatarImageErrorCode) {
    super(`avatar image: ${code}`)
    this.name = 'AvatarImageError'
    this.code = code
  }
}

export interface AvatarCrop {
  /** Source square: top-left corner and edge length, in source pixels. */
  sx: number
  sy: number
  sourceSize: number
  /** Edge length of the encoded square. Never upscales a small source. */
  outputSize: number
}

/** Largest centered square of the source, scaled down to at most AVATAR_SIZE. */
export function avatarCrop(width: number, height: number): AvatarCrop {
  const sourceSize = Math.min(width, height)
  return {
    sx: Math.floor((width - sourceSize) / 2),
    sy: Math.floor((height - sourceSize) / 2),
    sourceSize,
    outputSize: Math.max(1, Math.min(AVATAR_SIZE, sourceSize)),
  }
}

/**
 * Validate, crop and re-encode `file`. Throws `AvatarImageError` so the caller
 * can tell the user what was wrong with the file rather than a raw decode error.
 */
export async function prepareAvatarImage(file: File): Promise<Blob> {
  if (!(AVATAR_SOURCE_TYPES as readonly string[]).includes(file.type)) {
    throw new AvatarImageError('unsupported_type')
  }
  if (file.size > AVATAR_MAX_SOURCE_BYTES) throw new AvatarImageError('too_large')

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new AvatarImageError('decode_failed')
  }

  try {
    if (bitmap.width === 0 || bitmap.height === 0) throw new AvatarImageError('decode_failed')
    const crop = avatarCrop(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = crop.outputSize
    canvas.height = crop.outputSize
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new AvatarImageError('decode_failed')
    // JPEG has no alpha channel — flatten transparency onto white, not black.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, crop.outputSize, crop.outputSize)
    ctx.drawImage(
      bitmap,
      crop.sx,
      crop.sy,
      crop.sourceSize,
      crop.sourceSize,
      0,
      0,
      crop.outputSize,
      crop.outputSize,
    )
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', ENCODE_QUALITY),
    )
    if (!blob || blob.type !== 'image/jpeg') throw new AvatarImageError('decode_failed')
    return blob
  } finally {
    bitmap.close()
  }
}
