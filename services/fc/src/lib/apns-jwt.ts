// services/fc/src/lib/apns-jwt.ts
// ES256 JWT signer for APNs, with 50-min cache (APNs requires <60min).
import { importPKCS8, SignJWT } from 'jose';

const REFRESH_MS = 50 * 60 * 1000;

export function createApnsJwtCache({ privateKeyP8, keyId, teamId, nowMs = Date.now }) {
  let cached = null; // { token, mintedAt }
  let keyPromise = null;

  async function getKey() {
    if (!keyPromise) keyPromise = importPKCS8(privateKeyP8, 'ES256');
    return keyPromise;
  }

  async function mint() {
    const key = await getKey();
    const iat = Math.floor(nowMs() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: keyId })
      .setIssuer(teamId)
      .setIssuedAt(iat)
      .sign(key);
    return token;
  }

  return {
    async get() {
      if (cached && nowMs() - cached.mintedAt < REFRESH_MS) return cached.token;
      const token = await mint();
      cached = { token, mintedAt: nowMs() };
      return token;
    },
  };
}
