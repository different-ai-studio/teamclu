/**
 * Some containers in the self-host stack have NO login of their own and rely
 * entirely on whatever sits in front of them. Supabase Studio is the worst of
 * them: it holds the service_role key, JWT_SECRET and the Postgres password,
 * and its SQL editor connects as supabase_admin.
 *
 * The Caddyfile once proxied STUDIO_DOMAIN straight to `studio:3000`, skipping
 * the basic-auth plugin on Kong's `dashboard` route. Nothing failed, nothing
 * logged — the site simply served the database UI to anyone who knew the
 * hostname. These tests keep that from coming back unnoticed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "../../..");
const CADDYFILE = path.join(REPO, "deploy/self-host/caddy/Caddyfile");
const KONG = path.join(REPO, "deploy/self-host/supabase/volumes/api/kong.yml");
const ENV_EXAMPLES = [
  path.join(REPO, "deploy/self-host/.env.example"),
  path.join(REPO, "deploy/self-host/.env.local.example"),
];

/** Upstreams that answer every request as an administrator. */
const NO_LOGIN_OF_THEIR_OWN = ["studio", "meta", "registry"];

interface Proxy {
  upstream: string;
  line: number;
  /** True when a `basic_auth` opened in an enclosing block, before this line. */
  guarded: boolean;
}

/**
 * Every `reverse_proxy` in the file, with whether a `basic_auth` precedes it in
 * the same or an enclosing block. Walks braces line by line: the file is
 * hand-written and small, and comments are dropped first so a `{` in prose
 * cannot shift the depth.
 */
function proxies(file: string): Proxy[] {
  const out: Proxy[] = [];
  const authDepths: number[] = []; // depth of each block holding a basic_auth
  let depth = 0;
  fs.readFileSync(file, "utf8")
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.replace(/#.*$/, "").trim();
      if (!line) return;
      if (/^basic_auth\b/.test(line)) authDepths.push(depth);
      const m = /^reverse_proxy\s+(\S+)/.exec(line);
      if (m) out.push({ upstream: m[1], line: i + 1, guarded: authDepths.some((d) => d <= depth) });
      // `{$VAR}` placeholders open and close on the same line and cancel out.
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      while (authDepths.length && authDepths[authDepths.length - 1] > depth) authDepths.pop();
      if (depth === 0) authDepths.length = 0;
    });
  return out;
}

test("the Caddyfile parser sees the sites it is meant to police", () => {
  const upstreams = proxies(CADDYFILE).map((p) => p.upstream);
  // Vacuous-pass guard: if the walk above stops matching, fail loudly here.
  assert.ok(upstreams.includes("kong:8000"), "expected a reverse_proxy to kong:8000");
  assert.ok(upstreams.includes("registry:5000"), "expected a reverse_proxy to registry:5000");
});

test("no public site reaches a login-less admin container without basic_auth", () => {
  const exposed = proxies(CADDYFILE).filter(
    (p) => NO_LOGIN_OF_THEIR_OWN.includes(p.upstream.split(":")[0]) && !p.guarded,
  );
  assert.deepEqual(
    exposed.map((p) => `Caddyfile:${p.line} -> ${p.upstream}`),
    [],
    "these upstreams have no login of their own; route them through Kong or add basic_auth",
  );
});

test("Kong still puts basic-auth in front of Studio", () => {
  // The Studio site leans on this. If upstream's kong.yml ever drops the
  // plugin, routing through Kong protects nothing.
  const lines = fs.readFileSync(KONG, "utf8").split("\n");
  const start = lines.findIndex((l) => /^\s*- name: dashboard\s*$/.test(l));
  assert.ok(start >= 0, "kong.yml: `dashboard` service not found");
  const indent = lines[start].indexOf("-");
  const end = lines.findIndex((l, i) => i > start && l.trim() !== "" && l.indexOf("-") === indent && /^\s*- name:/.test(l));
  const block = lines.slice(start, end < 0 ? undefined : end).join("\n");
  assert.match(block, /url:\s*http:\/\/studio:3000/, "dashboard service no longer points at Studio");
  assert.match(block, /- name: basic-auth/, "dashboard route lost its basic-auth plugin");
});

test("example env files do not ship a published Studio password", () => {
  for (const file of ENV_EXAMPLES) {
    const m = /^DASHBOARD_PASSWORD=(.*)$/m.exec(fs.readFileSync(file, "utf8"));
    assert.ok(m, `${path.basename(file)}: DASHBOARD_PASSWORD missing`);
    assert.equal(m[1], "", `${path.basename(file)}: leave DASHBOARD_PASSWORD blank for gen-secrets.sh to fill`);
  }
});
