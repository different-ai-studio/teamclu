import { describe, expect, it } from 'vitest'
import {
  AVATAR_MAX_SOURCE_BYTES,
  AvatarImageError,
  avatarCrop,
  prepareAvatarImage,
} from '@/lib/actor/avatar-image'

function makeFile(name: string, type: string, bytes = 16): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

async function rejectionCode(file: File): Promise<string | null> {
  try {
    await prepareAvatarImage(file)
    return null
  } catch (e) {
    return e instanceof AvatarImageError ? e.code : `unexpected: ${String(e)}`
  }
}

describe('avatarCrop', () => {
  it('takes the centered square of a landscape image and scales it down', () => {
    expect(avatarCrop(4000, 3000)).toEqual({ sx: 500, sy: 0, sourceSize: 3000, outputSize: 512 })
  })

  it('takes the centered square of a portrait image', () => {
    expect(avatarCrop(1080, 1920)).toEqual({ sx: 0, sy: 420, sourceSize: 1080, outputSize: 512 })
  })

  it('never upscales a source smaller than the avatar size', () => {
    expect(avatarCrop(200, 120)).toEqual({ sx: 40, sy: 0, sourceSize: 120, outputSize: 120 })
  })
})

describe('prepareAvatarImage', () => {
  it('rejects types the avatars bucket does not store', async () => {
    expect(await rejectionCode(makeFile('anim.gif', 'image/gif'))).toBe('unsupported_type')
    expect(await rejectionCode(makeFile('photo.heic', 'image/heic'))).toBe('unsupported_type')
    expect(await rejectionCode(makeFile('notes.pdf', 'application/pdf'))).toBe('unsupported_type')
  })

  it('rejects an oversized source before decoding it', async () => {
    const file = makeFile('huge.jpg', 'image/jpeg')
    Object.defineProperty(file, 'size', { value: AVATAR_MAX_SOURCE_BYTES + 1 })
    expect(await rejectionCode(file)).toBe('too_large')
  })

  it('reports a file that cannot be decoded', async () => {
    // Not a real PNG — and jsdom has no createImageBitmap at all.
    expect(await rejectionCode(makeFile('broken.png', 'image/png'))).toBe('decode_failed')
  })
})
