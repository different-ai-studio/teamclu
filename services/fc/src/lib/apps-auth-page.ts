/**
 * The shell every page in the app login flow is rendered into.
 *
 * Shared between the central login service and the app-domain gateway because
 * a visitor crosses between the two hostnames mid-flow — the login form, the
 * code form, and the "wrong organisation" page are one experience, and a
 * second copy of this stylesheet would drift until they visibly were not.
 */

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Inline because these pages are served from bare hostnames with no asset
 * pipeline behind them, and a login page that waits on a second request is a
 * login page that flashes unstyled.
 */
const PAGE_CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#15181e;--muted:#6c7688;--line:#d9dee6;--accent:#2f5d8c;--err:#973340}
@media(prefers-color-scheme:dark){:root{--bg:#101318;--card:#171b22;--ink:#e8ebf0;--muted:#7d879a;--line:#2b323d;--accent:#7fb0dd;--err:#d98a95}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
background:var(--bg);color:var(--ink);
font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
.card{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:32px 28px}
h1{margin:0 0 6px;font-size:19px;font-weight:600;letter-spacing:-.01em}
p.sub{margin:0 0 22px;color:var(--muted);font-size:13.5px}
p.sub:last-child{margin-bottom:0}
label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:6px}
input{width:100%;height:40px;padding:0 12px;font:inherit;font-size:15px;color:var(--ink);
background:var(--bg);border:1px solid var(--line);border-radius:7px}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
button{width:100%;height:40px;margin-top:16px;font:inherit;font-size:14.5px;font-weight:500;
color:#fff;background:var(--accent);border:0;border-radius:7px;cursor:pointer}
button:hover{filter:brightness(1.08)}
a.btn{display:block;margin-top:16px;height:40px;line-height:38px;text-align:center;
font-size:14.5px;font-weight:500;color:var(--accent);text-decoration:none;
border:1px solid var(--accent);border-radius:7px}
a.btn:hover{background:var(--accent);color:#fff}
.err{margin:0 0 16px;padding:9px 12px;border-radius:7px;font-size:13px;
color:var(--err);border:1px solid currentColor;background:transparent}
.foot{margin:18px 0 0;font-size:12px;color:var(--muted);text-align:center}
.code-input{letter-spacing:.4em;font-variant-numeric:tabular-nums}
.methods{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px;justify-content:center}
.methods a{font-size:12.5px;color:var(--accent);text-decoration:none}
.methods a:hover{text-decoration:underline}
.account-choices{display:grid;gap:8px}
.account-choices button{height:auto;margin-top:0;padding:10px 12px;text-align:left;display:flex;flex-direction:column;gap:1px}
.account-choices small{font-size:12px;font-weight:400;opacity:.8}
`;

export function page(title: string, inner: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title><style>${PAGE_CSS}</style></head>` +
      `<body><main class="card">${inner}</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Never cache: on a shared machine the next visitor would otherwise be
        // handed the previous one's form state, address included.
        "Cache-Control": "no-store",
        "Referrer-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/** 302 with no-store, plus any cookies the step needs to set. */
export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/**
 * A path inside the app, never a way out of it.
 *
 * `//evil.example.com` is a protocol-relative URL that browsers treat as
 * another site, and a backslash is folded to `/` by several of them — so both
 * are rejected rather than escaped.
 */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/")) return "/";
  if (raw.startsWith("//") || raw.includes("\\")) return "/";
  return raw;
}
