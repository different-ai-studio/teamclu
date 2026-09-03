import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, bytesToDataUrl } from '../base64';

function roundTrip(bytes: Uint8Array) {
  return base64ToBytes(bytesToBase64(bytes));
}

describe('base64', () => {
  it('round-trips the empty buffer', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('');
    expect(roundTrip(new Uint8Array())).toEqual(new Uint8Array());
  });

  it('matches btoa for ASCII', () => {
    const bytes = new TextEncoder().encode('hello world');
    expect(bytesToBase64(bytes)).toBe(btoa('hello world'));
  });

  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(roundTrip(bytes)).toEqual(bytes);
  });

  it('round-trips across the chunk boundary', () => {
    // 0x2000 is the chunk size; straddle it in both directions so a boundary
    // off-by-one shows up as corrupted bytes rather than a silent pass.
    for (const len of [0x1fff, 0x2000, 0x2001, 0x4001]) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 31) % 256;
      expect(roundTrip(bytes)).toEqual(bytes);
    }
  });

  it('handles each padding length', () => {
    for (const len of [1, 2, 3, 4, 5]) {
      const bytes = new Uint8Array(len).fill(0xab);
      expect(roundTrip(bytes)).toEqual(bytes);
    }
  });

  it('builds a data URL', () => {
    const bytes = new TextEncoder().encode('hi');
    expect(bytesToDataUrl(bytes, 'image/png')).toBe(`data:image/png;base64,${btoa('hi')}`);
  });
});

describe('base64url', () => {
  it('drops padding and swaps the URL-unsafe alphabet', async () => {
    const { bytesToBase64Url, textToBase64Url } = await import('../base64');
    // 0xfb 0xff encodes as "+/8=" in standard base64.
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(textToBase64Url('/Users/me/work')).toBe(
      btoa('/Users/me/work').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    );
  });

  it('encodes non-ASCII text as UTF-8', async () => {
    const { textToBase64Url } = await import('../base64');
    const expected = btoa(String.fromCharCode(...new TextEncoder().encode('标题')))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(textToBase64Url('标题')).toBe(expected);
  });
});
