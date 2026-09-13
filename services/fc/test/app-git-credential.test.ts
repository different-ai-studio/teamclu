import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GIT_HTTPS_USERNAME,
  deserializeGitHttpsCredential,
  isHttpGitRemote,
  parseGitHttpsCredentialInput,
  serializeGitHttpsCredential,
} from "../src/lib/app-git-credential.js";

const rejects = (fn: () => unknown, match: RegExp) =>
  assert.throws(fn, (e: any) => e.statusCode === 400 && match.test(e.message), "accepted it");

test("a token alone is enough; the username falls back to one GitHub and GitLab accept", () => {
  assert.deepEqual(parseGitHttpsCredentialInput({ token: "ghp_abc" }), {
    username: DEFAULT_GIT_HTTPS_USERNAME,
    token: "ghp_abc",
  });
  assert.deepEqual(parseGitHttpsCredentialInput({ username: "", token: "ghp_abc" }), {
    username: DEFAULT_GIT_HTTPS_USERNAME,
    token: "ghp_abc",
  });
});

test("whitespace pasted around either field is trimmed off", () => {
  assert.deepEqual(parseGitHttpsCredentialInput({ username: " me ", token: "tok\n" }), {
    username: "me",
    token: "tok",
  });
});

test("a value git's line protocol could not carry is refused", () => {
  // A newline inside the token would end git's answer early and let the rest
  // be read as another attribute.
  rejects(() => parseGitHttpsCredentialInput({ token: "a\nb" }), /newlines or NUL/);
  rejects(() => parseGitHttpsCredentialInput({ token: "a\rb" }), /newlines or NUL/);
  rejects(() => parseGitHttpsCredentialInput({ username: "a\0b", token: "t" }), /newlines or NUL/);
});

test("a missing, blank or non-string token is refused", () => {
  rejects(() => parseGitHttpsCredentialInput({}), /token is required/);
  rejects(() => parseGitHttpsCredentialInput(null), /token is required/);
  rejects(() => parseGitHttpsCredentialInput({ token: "   " }), /token is required/);
  rejects(() => parseGitHttpsCredentialInput({ token: 42 }), /token must be a string/);
  rejects(() => parseGitHttpsCredentialInput({ token: "t", username: 7 }), /username must be a string/);
});

test("an oversized field is refused", () => {
  rejects(() => parseGitHttpsCredentialInput({ token: "t".repeat(4097) }), /longer than/);
  rejects(() => parseGitHttpsCredentialInput({ token: "t", username: "u".repeat(257) }), /longer than/);
});

test("the sealed plaintext round-trips, and one that is not a credential reads as none", () => {
  const credential = { username: "me", token: "glpat-xyz" };
  assert.deepEqual(deserializeGitHttpsCredential(serializeGitHttpsCredential(credential)), credential);
  assert.equal(deserializeGitHttpsCredential("not json"), null);
  assert.equal(deserializeGitHttpsCredential(JSON.stringify({ username: "me" })), null);
  assert.deepEqual(deserializeGitHttpsCredential(JSON.stringify({ token: "t" })), {
    username: DEFAULT_GIT_HTTPS_USERNAME,
    token: "t",
  });
});

test("only an http(s) address can use a stored token", () => {
  assert.ok(isHttpGitRemote("https://github.com/o/r.git"));
  assert.ok(isHttpGitRemote("HTTP://git.internal/o/r"));
  assert.ok(!isHttpGitRemote("git@github.com:o/r.git"));
  assert.ok(!isHttpGitRemote("ssh://git@github.com/o/r.git"));
  assert.ok(!isHttpGitRemote(null));
});
