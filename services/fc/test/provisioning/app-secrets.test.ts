import { test } from "node:test";
import assert from "node:assert/strict";
import {
  seal,
  open,
  requireAppSecretsEncryptionKey,
  OAUTH_CLIENT_SECRET_KIND,
} from "../../src/lib/provisioning/app-secrets.js";

test("roundtrip encrypt/decrypt oauth_client_secret", () => {
  process.env.APP_SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const ct = seal(OAUTH_CLIENT_SECRET_KIND, "super-secret");
  assert.equal(open(OAUTH_CLIENT_SECRET_KIND, ct), "super-secret");
});

test("seal throws 503 when APP_SECRETS_ENCRYPTION_KEY is missing", () => {
  const prev = process.env.APP_SECRETS_ENCRYPTION_KEY;
  delete process.env.APP_SECRETS_ENCRYPTION_KEY;
  try {
    assert.throws(
      () => seal(OAUTH_CLIENT_SECRET_KIND, "x"),
      (err: any) => err?.code === "app_secrets_unavailable" && /APP_SECRETS_ENCRYPTION_KEY/.test(err.message),
    );
  } finally {
    if (prev === undefined) delete process.env.APP_SECRETS_ENCRYPTION_KEY;
    else process.env.APP_SECRETS_ENCRYPTION_KEY = prev;
  }
});

test("requireAppSecretsEncryptionKey rejects non-32-byte keys", () => {
  process.env.APP_SECRETS_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
  assert.throws(
    () => requireAppSecretsEncryptionKey(),
    (err: any) => err?.code === "app_secrets_unavailable" && /32 bytes/.test(err.message),
  );
});
