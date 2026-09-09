#!/usr/bin/env node
// Generate an image through the team AI gateway.
//
// Zero dependencies (node: builtins only) — this runs inside an agent's bash
// tool on whatever Node the workspace has.
//
// ⚠️ THE ONE RULE: base64 never reaches stdout. One 1024² PNG is 1–3 MB of
// base64, and a single oversized tool result has been measured to break
// context compaction outright — the compaction call itself exceeds the limit
// and every retry burns for nothing. We write the file and print its path.
import { writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 || i + 1 >= args.length ? fallback : args[i + 1];
};

const prompt = flag("prompt");
if (!prompt) {
  console.error('Usage: node generate.mjs --prompt "..." [--n 1] [--size 1024x1024] [--quality medium] [--out-dir .]');
  process.exit(2);
}
const n = Number(flag("n", "1")) || 1;
const size = flag("size", "1024x1024");
const quality = flag("quality");
const outDir = resolve(flag("out-dir", process.cwd()));

// The daemon injects both of these at spawn. The token is NOT in the payload —
// the payload names the env var holding it, so the credential never travels as
// part of a JSON blob that might get logged.
let provider;
try {
  provider = JSON.parse(process.env.TEAMCLU_TEAM_PROVIDER || "");
} catch {
  console.error("当前团队没有启用 AI 网关（TEAMCLU_TEAM_PROVIDER 未设置）。请联系团队管理员开启。");
  process.exit(1);
}
const token = process.env[provider.apiKeyEnv || "tc_gateway_token"];
if (!provider.baseUrl || !token) {
  console.error("AI 网关凭证不可用。重启一次会话通常可以恢复；如果仍然失败，请联系团队管理员。");
  process.exit(1);
}

const body = { model: "image", prompt, n, size };
if (quality) body.quality = quality;

const url = `${provider.baseUrl.replace(/\/+$/, "")}/images/generations`;
let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    // Generation is one-shot with no streaming first byte; 30s is typical and
    // the gateway's own ceiling is 180s, so allow a little more than that.
    signal: AbortSignal.timeout(200_000),
  });
} catch (e) {
  console.error(e?.name === "TimeoutError" ? "生成超时，请重试一次。" : `无法连接 AI 网关：${e.message}`);
  process.exit(1);
}

const text = await res.text();
let json = null;
try { json = JSON.parse(text); } catch { /* keep raw */ }

if (!res.ok) {
  // These are all things the user can act on, so say what to do rather than
  // dumping the provider's JSON into the conversation.
  const code = json?.error?.code || json?.code || "";
  const msg = json?.error?.message || json?.message || text.slice(0, 300);
  const say = {
    insufficient_credits: "团队积分不足，无法生成图片。请联系管理员充值。",
    quota_exceeded: "你的个人额度已用完。请联系团队管理员调整限额。",
    model_not_allowed: "这个部署没有开启图片生成（网关未配置 image 档）。",
    unpriced_image_variant: `这个尺寸暂不支持：${msg}。试试 --size 1024x1024。`,
  }[code];
  if (say) console.error(say);
  else if (res.status === 404) console.error("当前团队没有启用 AI 网关。请联系团队管理员开启。");
  else console.error(`生成失败（HTTP ${res.status}）：${msg}`);
  process.exit(1);
}

const items = Array.isArray(json?.data) ? json.data : [];
if (items.length === 0) {
  console.error("上游没有返回任何图片，可能是内容审核拦截。换个描述再试。");
  process.exit(1);
}

const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image";
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const ext = (json.output_format || "png").replace("jpeg", "jpg");

const written = [];
for (const [i, item] of items.entries()) {
  if (!item?.b64_json) continue;
  const name = items.length > 1 ? `${slug}-${stamp}-${i + 1}.${ext}` : `${slug}-${stamp}.${ext}`;
  const buf = Buffer.from(item.b64_json, "base64");
  writeFileSync(join(outDir, name), buf);
  written.push({ name, bytes: buf.length, revised: item.revised_prompt });
}

// stdout, and only this. Relative names so the caller can drop them straight
// into a markdown image reference (see SKILL.md — an absolute or out-of-session
// path renders as nothing at all in the desktop chat).
for (const w of written) {
  console.log(`${w.name}  (${(w.bytes / 1024).toFixed(0)} KB, ${json.size || size})`);
  if (w.revised) console.log(`  改写后的提示词: ${w.revised}`);
}
