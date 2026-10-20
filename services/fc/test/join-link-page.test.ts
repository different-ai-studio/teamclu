import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { renderJoinLinkPage } from "../src/lib/join-link-page.js";

test("active page names the team and posts the otp endpoints", () => {
  const html = renderJoinLinkPage({
    teamName: "示例团队",
    inviterDisplayName: "林",
    expiresAt: null,
    status: "active",
    token: "tok",
  });
  assert.match(html, /示例团队/);
  assert.match(html, /林/);
  assert.match(html, /\/v1\/auth\/signin-otp/);
  assert.match(html, /\/v1\/auth\/verify-otp/);
  assert.match(html, /\/v1\/join-links\/tok\/join/);
  assert.match(html, /请输入邮箱/);
  assert.doesNotMatch(html, /phone\/send-code/);
  assert.doesNotMatch(html, /phone\/login/);
  assert.doesNotMatch(html, /手机/);
  assert.doesNotMatch(html, /signin-password/);
  assert.doesNotMatch(html, /"sms"/);
});

test("active page escapes team name in inline script against script breakout", () => {
  const malicious = "</script><img src=x onerror=alert(1)>";
  const html = renderJoinLinkPage({
    teamName: malicious,
    inviterDisplayName: "林",
    expiresAt: null,
    status: "active",
    token: "tok",
  });
  assert.match(html, /\\u003c/);
  assert.doesNotMatch(html, /<img/);
});

test("revoked page explains and has no login form", () => {
  const html = renderJoinLinkPage({
    teamName: "示例团队",
    inviterDisplayName: "林",
    expiresAt: null,
    status: "revoked",
    token: "tok",
  });
  assert.match(html, /这条链接已停用/);
  assert.doesNotMatch(html, /signin-otp/);
  assert.doesNotMatch(html, /phone\/send-code/);
});

test("GET /join/:token renders preview html", async () => {
  const app = createApp({
    createRepository: () => ({}),
    createAuthRepository: () => ({
      previewJoinLink: async (token: string) => ({
        teamName: "示例团队",
        inviterDisplayName: "林",
        expiresAt: null,
        status: "active",
        token,
      }),
    }),
  } as any);
  const res = await app.request("/join/tok");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.match(await res.text(), /示例团队/);
});
