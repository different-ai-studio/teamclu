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
  const joinUrlJs = JSON.stringify(`/v1/join-links/${preview.token}/join`);
  const teamNameJs = JSON.stringify(preview.teamName);
  const body = `
    <h1>${teamName}</h1>
    <p>${inviter} 邀请你加入这个团队</p>
    <form id="join-form">
      <label for="contact">邮箱或手机号</label>
      <input id="contact" name="contact" type="text" autocomplete="username" required>
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

      function parseContact(raw) {
        const contact = String(raw ?? "").trim();
        if (contact.includes("@")) return { email: contact };
        if (contact.startsWith("+")) return { phone: contact };
        if (/^1\\d{10}$/.test(contact)) return { phone: "+86" + contact };
        return null;
      }

      function show(message) {
        statusEl.textContent = message;
      }

      async function sendOtp() {
        const parsed = parseContact(contactEl.value);
        if (!parsed) {
          show("请输入邮箱，或 +开头的手机号");
          return;
        }
        const url = parsed.email ? "/v1/auth/signin-otp" : "/v1/auth/phone/send-code";
        const body = parsed.email
          ? { email: parsed.email }
          : { phone: parsed.phone, captchaVerify: "desktop-captcha-pending" };
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          show("验证码发送失败");
          return;
        }
        show("验证码已发送");
      }

      async function redeem() {
        const parsed = parseContact(contactEl.value);
        if (!parsed) {
          show("请输入邮箱，或 +开头的手机号");
          return;
        }
        const code = String(codeEl.value ?? "").trim();
        let access_token;
        if (parsed.email) {
          const verifyRes = await fetch("/v1/auth/verify-otp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: parsed.email, token: code, type: "email" }),
          });
          const verifyJson = await verifyRes.json().catch(() => ({}));
          if (!verifyRes.ok) {
            show("验证失败");
            return;
          }
          access_token = verifyJson.access_token;
        } else {
          const loginRes = await fetch("/v1/auth/phone/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: parsed.phone, code }),
          });
          const loginJson = await loginRes.json().catch(() => ({}));
          if (!loginRes.ok) {
            show("验证失败");
            return;
          }
          if (loginJson.multiUser === true) {
            show("这个手机号对应多个账号，请改用邮箱加入。");
            return;
          }
          access_token = loginJson.session && loginJson.session.access_token;
        }
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
        show("已加入「" + teamName + "」。用同一手机号或邮箱打开 TeamClu 即可看到这个团队。");
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
