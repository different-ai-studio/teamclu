// PKCE (RFC 7636) verifier + S256 challenge generation using Web Crypto.
// Used by the desktop OAuth loopback flow.

import { bytesToBase64Url } from '@/lib/base64'

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export async function generatePkce(): Promise<PkcePair> {
  const random = new Uint8Array(32);
  crypto.getRandomValues(random);
  const verifier = bytesToBase64Url(random); // 43-char base64url, within RFC range
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = bytesToBase64Url(new Uint8Array(digest));
  return { verifier, challenge };
}
