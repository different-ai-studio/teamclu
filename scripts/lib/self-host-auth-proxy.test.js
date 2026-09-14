"use strict";
/**
 * GoTrue fetches the mailer templates over HTTP at send time
 * (`internal/mailer/templatemailer`), through Go's default transport, which
 * honours `HTTP_PROXY` / `NO_PROXY`. When self-host sets `AUTH_EGRESS_PROXY`
 * for Google OAuth, every internal template URL has to be exempted too —
 * otherwise the fetch is sent to the external proxy, which cannot resolve the
 * compose-internal name, the fetch fails, and GoTrue SILENTLY falls back to its
 * embedded "Your Magic Link" template. The template files on disk stay correct;
 * the code-only OTP email just never arrives.
 *
 * That is invisible in the logs (the fallback is not an error), so pin it here.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "../..");
const composePath = path.join(repoRoot, "deploy/self-host/supabase/docker-compose.yml");

/** The lines of one top-level (2-space indent) service block. */
function serviceBlock(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^ {2}${name}: *$`).test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

/** The value of `KEY:` anywhere inside a service block. */
function envValue(block, key) {
  const m = block.join("\n").match(new RegExp(`^ +${key}: *(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

test("auth NO_PROXY exempts every internal mailer template host", () => {
  const text = fs.readFileSync(composePath, "utf8");
  const auth = serviceBlock(text, "auth");
  assert.ok(auth, "`auth:` service not found in supabase/docker-compose.yml");

  const noProxy = envValue(auth, "NO_PROXY");
  assert.ok(noProxy, "auth service has no NO_PROXY — template fetches would bypass the proxy check");

  const templateUrls = auth
    .map((line) => line.match(/^ +GOTRUE_MAILER_TEMPLATES_[A-Z_]+: *(\S+)/))
    .filter(Boolean)
    .map((m) => m[1]);

  // A silent parse failure would pass the loop below while checking nothing.
  assert.ok(
    templateUrls.length > 0,
    "no GOTRUE_MAILER_TEMPLATES_* entries found — the parser or the compose file changed shape",
  );

  const exempt = new Set(noProxy.split(",").map((s) => s.trim()));
  for (const url of templateUrls) {
    const host = new URL(url).hostname;
    // Only compose-internal names (no dot) are at risk; a public host is
    // reachable through the proxy and does not belong in NO_PROXY.
    if (!host.includes(".")) {
      assert.ok(
        exempt.has(host),
        `auth NO_PROXY is missing "${host}" (from ${url}); GoTrue would fetch it ` +
          "through AUTH_EGRESS_PROXY and silently fall back to the default Magic Link email",
      );
    }
  }
});
