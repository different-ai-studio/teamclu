// PERF-16 — one implementation of bytes ⇄ base64.
//
// There were seven copies of `for (b of bytes) binary += String.fromCharCode(b)`
// (and two of `Array.from(data).map(...).join('')`, which is worse: it
// allocates one single-character string per byte before joining them). On a
// 4 MB image preview that is four million string allocations on the main
// thread between the user clicking a file and seeing it.
//
// `Uint8Array.prototype.toBase64` / `Uint8Array.fromBase64` do the whole
// conversion in the engine. They are recent (WebKit 18.2, Chrome 140), so
// everything falls back to a chunked `String.fromCharCode.apply`, which is
// still one call per 8 KB instead of one per byte.

/** Bytes per `fromCharCode.apply` call. Large enough to matter, small enough
 *  to stay well under the engine's argument-count limit. */
const CHUNK = 0x2000;

type ToBase64 = { toBase64(): string };
type FromBase64 = { fromBase64(s: string): Uint8Array };

export function bytesToBase64(bytes: Uint8Array): string {
  const native = bytes as unknown as Partial<ToBase64>;
  if (typeof native.toBase64 === 'function') {
    return native.toBase64();
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const native = Uint8Array as unknown as Partial<FromBase64>;
  if (typeof native.fromBase64 === 'function') {
    return native.fromBase64(base64);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `data:<mime>;base64,<…>` for a byte buffer. */
export function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

/** Unpadded base64url (RFC 4648 §5) — what URLs, IDs and PKCE verifiers use. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** UTF-8 encode, then unpadded base64url. */
export function textToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}
