export type JoinLinkPageInput = {
  teamName: string;
  inviterDisplayName: string;
  expiresAt: string | null;
  status: string;
  token: string;
};

const INACTIVE: Record<string, string> = {
  revoked: "这条链接已停用",
  expired: "这条链接已过期",
  exhausted: "这条链接已达到人数上限",
  invalid: "链接无效",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Safe to embed in an inline {@code <script>}: blocks {@code </script>} and HTML comments. */
function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function documentHtml(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: "PingFang SC", "Noto Sans SC", "Source Han Sans SC", system-ui, sans-serif; background: #fbfaf7; color: #1a1a14; }
    main { max-width: 28rem; margin: 4rem auto; padding: 1.5rem; background: #fff; border-radius: 16px; }
    h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
    p { font-size: 0.9375rem; line-height: 1.6; color: #3d3c34; }
    label { display: block; font-size: 0.8125rem; margin: 0.75rem 0 0.25rem; }
    input { width: 100%; box-sizing: border-box; padding: 0.5rem 0.75rem; border: 1px solid rgba(26,26,20,0.08); border-radius: 8px; font: inherit; }
    button { margin-top: 0.75rem; margin-right: 0.5rem; padding: 0.4rem 0.9rem; border: 0; border-radius: 8px; background: #e85a4a; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    button[disabled] { opacity: 0.4; }
    #status { min-height: 1.4em; margin-top: 1rem; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

function inactivePage(status: string): string {
  const sentence = INACTIVE[status] ?? INACTIVE.invalid;
  return documentHtml(sentence, `<p>${escapeHtml(sentence)}</p>`);
}

function activePage(preview: JoinLinkPageInput): string {
  const teamName = escapeHtml(preview.teamName);
  const inviter = escapeHtml(preview.inviterDisplayName);
  const joinUrlJs = jsonForInlineScript(`/v1/join-links/${preview.token}/join`);
  const teamNameJs = jsonForInlineScript(preview.teamName);
  const body = `
    <h1>${teamName}</h1>
    <p>${inviter} 邀请你加入这个团队</p>
    <form id="join-form">
      <label for="contact">邮箱</label>
      <input id="contact" name="contact" type="email" autocomplete="email" required>
      <label for="code">验证码</label>
      <input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code">
      <button type="button" id="send-code">发送验证码</button>
      <button type="submit">加入</button>
    </form>
    <p id="status"></p>
    <script>
      const joinUrl = ${joinUrlJs};
      const teamName = ${teamNameJs};
      const statusEl = document.getElementById("status");
      const contactEl = document.getElementById("contact");
      const codeEl = document.getElementById("code");

      function parseEmail(raw) {
        const email = String(raw ?? "").trim();
        if (email.includes("@")) return email;
        return null;
      }

      function show(message) {
        statusEl.textContent = message;
      }

      async function sendOtp() {
        const email = parseEmail(contactEl.value);
        if (!email) {
          show("请输入邮箱");
          return;
        }
        const res = await fetch("/v1/auth/signin-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        if (!res.ok) {
          show("验证码发送失败");
          return;
        }
        show("验证码已发送");
      }

      async function redeem() {
        const email = parseEmail(contactEl.value);
        if (!email) {
          show("请输入邮箱");
          return;
        }
        const code = String(codeEl.value ?? "").trim();
        const verifyRes = await fetch("/v1/auth/verify-otp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, token: code, type: "email" }),
        });
        const verifyJson = await verifyRes.json().catch(() => ({}));
        if (!verifyRes.ok) {
          show("验证失败");
          return;
        }
        const access_token = verifyJson.access_token;
        const joinRes = await fetch(joinUrl, {
          method: "POST",
          headers: { Authorization: "Bearer " + access_token },
        });
        const joinJson = await joinRes.json().catch(() => ({}));
        if (!joinRes.ok) {
          show("加入失败");
          return;
        }
        if (joinJson.alreadyMember === true) {
          show("你已经在这个团队里");
          return;
        }
        show("已加入「" + teamName + "」。用同一邮箱打开 TeamClu 即可看到这个团队。");
      }

      document.getElementById("send-code").addEventListener("click", (event) => {
        event.preventDefault();
        sendOtp();
      });
      document.getElementById("join-form").addEventListener("submit", (event) => {
        event.preventDefault();
        redeem();
      });
    </script>
  `;
  return documentHtml(preview.teamName, body);
}

export function renderJoinLinkPage(preview: JoinLinkPageInput): string {
  if (preview.status !== "active") return inactivePage(preview.status);
  return activePage(preview);
}
