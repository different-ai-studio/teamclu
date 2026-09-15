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
 * The app a page belongs to, named in the top-left corner where a product's
 * own sign-in page puts its logo. Someone who followed a link into a login
 * form has to be able to tell which app is asking before they type into it.
 */
export type PageApp = {
  /** Seeds the monogram colour, so one app keeps one colour across visits. */
  id: string;
  name: string;
};

export type PageOptions = {
  /** Null on pages reached without an app, e.g. the login domain opened directly. */
  app?: PageApp | null;
};

/**
 * Inline because these pages are served from bare hostnames with no asset
 * pipeline behind them, and a login page that waits on a second request is a
 * login page that flashes unstyled.
 */
const PAGE_CSS = `
:root{color-scheme:light;--bg:#f4f6f9;--card:#fff;--panel:#f8f9fb;--ink:#1d2330;--ink-2:#394150;--muted:#6b7280;--faint:#a0a6b1;
--line:#dde2ea;--line-soft:#eceff4;--accent:#2f6fed;--accent-hover:#2560d8;--accent-ink:#fff;--accent-soft:#edf2fe;--focus:rgba(47,111,237,.16);
--err:#b42318;--err-bg:#fef3f2;--err-line:#fdd4cf;--ok:#067647;--ok-bg:#ecfdf3}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0f1217;--card:#171b22;--panel:#13171d;--ink:#e8ebf0;--ink-2:#c5cad3;--muted:#8d95a3;--faint:#636b79;
--line:#2a303a;--line-soft:#222731;--accent:#5b8cff;--accent-hover:#7aa2ff;--accent-ink:#0b1020;--accent-soft:rgba(91,140,255,.12);--focus:rgba(91,140,255,.24);
--err:#f4a19a;--err-bg:rgba(244,161,154,.08);--err-line:rgba(244,161,154,.28);--ok:#75e0a7;--ok-bg:rgba(117,224,167,.1)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);
font:15px/1.55 "PingFang SC","Hiragino Sans GB","Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
-webkit-font-smoothing:antialiased}
.top{display:flex;align-items:center;gap:12px;padding:28px 40px;min-width:0}
.top-name{font-size:20px;font-weight:650;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mark{flex:none;display:inline-grid;place-items:center;width:38px;height:38px;border-radius:10px;font-size:18px;font-weight:700;line-height:1;
background:hsl(var(--hue,214) 85% 93%);color:hsl(var(--hue,214) 55% 38%)}
.mark svg{width:19px;height:19px}
.mark-sm{width:40px;height:40px;font-size:17px}
.mark-neutral{background:var(--ink);color:var(--card)}
.shell{flex:1;display:flex;justify-content:center;padding:2vh 16px 72px}
.card{width:100%;max-width:468px;align-self:flex-start;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:44px 48px 40px;overflow:hidden}
.eyebrow{margin:0 0 6px;color:var(--muted);font-size:15px}
.eyebrow strong{color:var(--ink-2);font-weight:600}
h1{margin:0 0 10px;font-size:30px;line-height:1.25;font-weight:700;letter-spacing:-.02em}
.eyebrow+h1{margin-bottom:28px}
p.sub{margin:0 0 26px;color:var(--muted);font-size:15px}
p.sub:last-child{margin-bottom:0}
p.sub strong{color:var(--ink);font-weight:600;word-break:break-all}
.status{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;margin:0 0 22px}
.status svg{width:26px;height:26px}
.status-ok{background:var(--ok-bg);color:var(--ok)}
.status-warn{background:var(--err-bg);color:var(--err)}
.status-lock{background:var(--accent-soft);color:var(--accent)}
.tabs{display:flex;gap:4px;padding:4px;margin:0 0 22px;background:var(--bg);border-radius:9px}
.tabs a{flex:1;text-align:center;padding:8px 6px;border-radius:6px;font-size:14px;color:var(--muted);text-decoration:none;white-space:nowrap}
.tabs a:hover{color:var(--ink)}
.tabs a[aria-current=page]{background:var(--card);color:var(--ink);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.1)}
.field{display:block;margin:0 0 14px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
input{display:block;width:100%;height:52px;padding:0 16px;font:inherit;font-size:16px;color:var(--ink);background:var(--card);
border:1px solid var(--line);border-radius:8px;transition:border-color .15s,box-shadow .15s}
input::placeholder{color:var(--faint)}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 4px var(--focus)}
.code-input{text-align:center;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:24px;letter-spacing:.45em;padding-left:calc(16px + .45em)}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:52px;margin:0;padding:0 16px;font:inherit;font-size:16px;
font-weight:500;border-radius:8px;cursor:pointer;text-decoration:none;transition:background-color .15s,border-color .15s,opacity .15s}
.btn svg{width:20px;height:20px;flex:none}
.btn-primary{margin-top:8px;color:var(--accent-ink);background:var(--accent);border:1px solid var(--accent)}
.btn-primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn-outline{color:var(--ink);background:var(--card);border:1px solid var(--line)}
.btn-outline:hover{background:var(--panel);border-color:var(--faint)}
.btn.busy{opacity:.65;cursor:progress}
.btn:focus-visible,.link:focus-visible,.tabs a:focus-visible,.account:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.divider{display:flex;align-items:center;gap:14px;margin:26px 0 18px;color:var(--faint);font-size:13px}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:var(--line)}
.alt{display:grid;gap:12px}
.err,.note{margin:0 0 18px;padding:11px 14px;border-radius:8px;font-size:14px}
.err{color:var(--err);background:var(--err-bg);border:1px solid var(--err-line)}
.note{color:var(--accent);background:var(--accent-soft);border:1px solid transparent}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:20px;font-size:14.5px}
.row form{margin:0}
.link{color:var(--accent);text-decoration:none;background:none;border:0;padding:0;font:inherit;cursor:pointer}
.link:hover{text-decoration:underline}
.link-muted{color:var(--muted)}
.link-muted:hover{color:var(--ink)}
.foot{margin:22px 0 0;font-size:14.5px;color:var(--muted);text-align:center}
.consent{margin:32px -48px -40px;padding:20px 48px 22px;background:var(--panel);border-top:1px solid var(--line-soft)}
.consent-app{display:flex;align-items:center;gap:12px;min-width:0}
.consent-who{display:flex;flex-direction:column;min-width:0;line-height:1.4}
.consent-who strong{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.consent-who>span{font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.consent p{margin:12px 0 0;font-size:13px;color:var(--muted)}
.consent-who .host{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px}
.account-choices{display:grid;gap:10px}
.account{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;text-align:left;font:inherit;color:var(--ink);
background:var(--card);border:1px solid var(--line);border-radius:8px;cursor:pointer;transition:border-color .15s,background-color .15s}
.account:hover{border-color:var(--accent);background:var(--accent-soft)}
.account .who{display:flex;flex-direction:column;min-width:0;line-height:1.4}
.account strong{font-size:15px;font-weight:600}
.account small{font-size:13px;color:var(--muted)}
@media(prefers-color-scheme:dark){.mark:not(.mark-neutral){background:hsl(var(--hue,214) 35% 21%);color:hsl(var(--hue,214) 85% 78%)}}
@media(max-width:560px){.top{padding:20px 20px 12px}.top-name{font-size:18px}.shell{padding-top:0}
.card{padding:32px 22px 28px}.consent{margin:28px -22px -28px;padding:18px 22px 20px}h1{font-size:26px}}
`;

/**
 * Marks a form as sent and ignores a second submit, so a double click on
 * "发送验证码" sends one code rather than two and does not trip the limiter.
 *
 * The button is dimmed with a class, never `disabled`: a disabled submitter is
 * left out of the form data, and the account picker's buttons carry the chosen
 * account as their value. `pageshow` clears the mark for a page restored from
 * the back/forward cache, which would otherwise come back unable to submit.
 */
const SUBMIT_ONCE =
  `document.addEventListener("submit",function(e){var f=e.target;` +
  `if(f.hasAttribute("data-sent")){e.preventDefault();return}f.setAttribute("data-sent","");` +
  `var b=e.submitter||f.querySelector("[type=submit]");if(b)b.classList.add("busy")});` +
  `addEventListener("pageshow",function(){document.querySelectorAll("[data-sent]").forEach(function(f){f.removeAttribute("data-sent")});` +
  `document.querySelectorAll(".busy").forEach(function(b){b.classList.remove("busy")})});`;

const ICONS = {
  ok: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
};

const MARK_HUES = [214, 250, 280, 330, 12, 30, 152, 188];

function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return MARK_HUES[h % MARK_HUES.length];
}

/** A coloured monogram. Apps have no icon, and an initial is still recognisable. */
export function mark(seed: string, label: string, className = "mark"): string {
  const initial = Array.from(label.trim())[0]?.toUpperCase() ?? "?";
  return `<span class="${className}" style="--hue:${hueFor(seed)}" aria-hidden="true">${esc(initial)}</span>`;
}

/** The round badge that opens a status page (signed out, no access, and so on). */
export function statusIcon(kind: "ok" | "warn" | "lock"): string {
  return `<div class="status status-${kind}" aria-hidden="true">${ICONS[kind]}</div>`;
}

export function page(title: string, inner: string, status = 200, options: PageOptions = {}): Response {
  const app = options.app ?? null;
  const brand = app
    ? `${mark(app.id, app.name)}<span class="top-name">${esc(app.name)}</span>`
    : `<span class="mark mark-neutral" aria-hidden="true">${ICONS.lock}</span><span class="top-name">应用登录</span>`;
  return new Response(
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta name="robots" content="noindex">` +
      `<title>${esc(app ? `${title} · ${app.name}` : title)}</title><style>${PAGE_CSS}</style></head>` +
      `<body><header class="top">${brand}</header>` +
      `<main class="shell"><div class="card">${inner}</div></main>` +
      `<script>${SUBMIT_ONCE}</script></body></html>`,
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
