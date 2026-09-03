/**
 * Opaque row identity for the app data browser.
 *
 * The API addresses a row by its primary-key VALUES, not by a column→value
 * map, and carries them in a URL path segment. Base64url of the ordered array
 * is what makes that survive: a composite key needs several values, and a value
 * is arbitrary user data that may well contain a slash.
 *
 * The server decodes this and zips it back against the table's primary key read
 * from its own catalog — the order here must match the `primaryKey` the server
 * reported, which is why this takes that array rather than guessing.
 */
import { textToBase64Url } from '@/lib/base64'

export function appDataRowKey(
  primaryKey: readonly string[],
  row: Record<string, unknown>,
): string {
  const values = primaryKey.map((column) => row[column]);
  // `textToBase64Url` UTF-8 encodes first: btoa is byte-oriented, and a
  // non-ASCII key value (a Chinese title as a primary key is unusual but
  // legal) would otherwise throw InvalidCharacterError.
  return textToBase64Url(JSON.stringify(values));
}
