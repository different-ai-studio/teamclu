import { describe, expect, it } from "vitest";
import { generatePkce } from "@/lib/auth/oauth-pkce";

// RFC 7636 worked example: this verifier must produce this exact S256 challenge.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

async function challengeFor(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("generatePkce", () => {
  it("produces a base64url verifier and matching S256 challenge", async () => {
    const { verifier, challenge } = await generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(await challengeFor(verifier));
  });

  it("matches the RFC 7636 S256 reference vector", async () => {
    // generatePkce randomizes the verifier, so verify the challenge derivation
    // directly against the published reference pair.
    expect(await challengeFor(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it("returns a fresh verifier each call", async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });
});
