# TeamClu — Chrome Web Store resubmission (v0.2.0)

Item: `nlmkpmokfbboonocdnngddbfpdedkfee` · Dashboard: https://chrome.google.com/webstore/devconsole

Background (rejections of 0.1.1): Aug 10 / Aug 14 “Red Potassium” (reviewer could not sign in),
“Purple Nickel” (privacy policy did not cover collection / use / storage / sharing), Aug 26 generic
Program Policies. This file is the exact text to enter; keep it in sync with
`apps/extension/manifest.json` and `docs/chrome-extension-privacy.md`.

## 1. Package

- Upload the zip built from this branch (`BUILD_ENV=production pnpm --filter @teamclu/extension build`,
  then zip `apps/extension/dist`). Version **0.2.0** (> 0.1.1).
- Permissions in the package: `sidePanel`, `activeTab`, `scripting`, `storage`, `identity`;
  `optional_host_permissions`: `http://*/*`, `https://*/*`. **No** `tabs`, **no** install-time host
  permissions, **no** static content scripts.
- Do **not** publish via a tag push: `release-extension.yml` now only publishes on a manual
  dispatch with `brand=teamclu`, `publish=true`.

## 2. Store listing

- **Category**: Productivity
- **Summary** (from package): see `apps/extension/_locales/*/messages.json` → `extensionDescription`
- **Description**: paste `storeDesc` from the same files (en / zh_CN).
- **Icon**: `apps/extension/icons/icon-128.png` (brand “Aperture” mark on the cream app-icon body,
  96 px artwork + 16 px transparent margin — readable on light and dark toolbars).
- **Screenshots** (1280×800, 24-bit, no alpha): one per language (sign-in screen next to a page).
  Add signed-in screenshots (chat + page-access dialog) once captured with the reviewer account.
- **Homepage / support URL**: https://www.teamclu.ai

## 3. Privacy practices tab

**Single purpose**
```
TeamClu adds a Chrome side panel in which the user chats with their team and their team's AI agents and, when the user chooses, shares the web page they are viewing as context for that conversation.
```

**Permission justifications**

- `sidePanel`
  ```
  Shows the TeamClu chat UI in Chrome's side panel when the user clicks the toolbar button.
  ```
- `activeTab`
  ```
  After the user clicks the TeamClu toolbar button, lets the extension read the page in the current tab — only when the user approves an agent's request to read that page, or explicitly shares it.
  ```
- `scripting`
  ```
  Injects the bundled content script that extracts the text/links of the page the user approved sharing, and shows the optional link button on sites the user allow-listed. No remote code is injected.
  ```
- `storage`
  ```
  Stores local settings in the browser: the user's link-button allow-list, the page-access and diagnostics choices, and short-lived hand-off state between the page and the side panel.
  ```
- `identity`
  ```
  Used only for chrome.identity.launchWebAuthFlow to complete the optional "Sign in with Google" OAuth flow. No other Google data or API is accessed.
  ```
- Host permissions (optional: `http://*/*`, `https://*/*`)
  ```
  Declared as optional host permissions and NOT granted at install. Chrome asks the user only when (a) they approve an AI agent's request to read the current page, or (b) they add a site to the link-button allow-list in Settings (then only that site is requested). Without the grant, nothing is read from any page.
  ```

**Remote code**: select **“No, I am not using remote code.”** (Currently the dashboard says *Yes*
while the justification says there is none — that contradiction alone is a policy problem.)
All JavaScript (background, content script, side panel) is bundled in the package; `sidepanel/index.html`
loads only local `./scripts/*.js` / `./assets/*.js`; there is no `eval` / `new Function` in the build.
The side panel only exchanges data (JSON over HTTPS / MQTT over WSS) with the TeamClu API.

**Data usage — check:**

- [x] Personally identifiable information (email, name, Google profile picture)
- [x] Authentication information (password at sign-in, session tokens)
- [x] Personal communications (chat messages and attachments)
- [x] Website content (text/links/outline of pages the user shares)
- [x] Web history — conservative: the URL/title of a shared page is sent with it
- [ ] Health, Financial/payment, Location, User activity — not collected
  (error reports are opt-in, off by default, and are disclosed in the policy)

Certifications: check all three (not sold; not used for unrelated purposes; not used for
creditworthiness/lending).

**Privacy policy URL**: `https://www.teamclu.ai/privacy-extension` — deploy the
teamclaw-website PR first, then confirm the page shows “Last updated: October 21, 2026”.

## 4. Test instructions (visible to reviewers only — enter the password there, nowhere else)

```
Backend: https://api.teamclu-dev.ucar.cc (production TeamClu service; "-dev" is a historical name). It is online 24/7 and reachable worldwide.

Test account — email + password, no email code and no 2FA needed:
  Email:    chrome-review@teamclaw-dev.ucar.cc
  Password: <PASSWORD>
  Backup:   chrome-review-backup@teamclaw-dev.ucar.cc (same password)
(The addresses are login IDs only; no mailbox access is needed.)

Steps:
1. Click the TeamClu toolbar icon. The side panel opens on the sign-in screen.
2. Select the "Password" tab (not "Email"), enter the credentials above and click "Sign in".
3. You are in the team "Chrome Review Demo". Its agent "Chrome Review Daemon" runs on our server 24/7. Click "New session" (or open an existing session) and send "Hello" — the agent replies within a few seconds.
4. Open an article, e.g. https://en.wikipedia.org/wiki/Collaborative_software, and send: "Read the current page and summarize it."
   The side panel shows "Share this page with the agent?". Click "Allow once". The first time, Chrome asks you to grant TeamClu site access — click "Allow". The agent then replies with a summary. Nothing is read from a page before you approve.
5. Optional: Settings (gear icon) → General → add "wikipedia.org" under "Page quick-open button" and approve Chrome's prompt. Hovering a link on Wikipedia then shows a small TeamClu button that sends that link to the agent.
6. Settings → General → Privacy lets you switch agent page access and error reports on/off.

If anything fails, contact contact@teamclu.ai.
```

## 5. Note to reviewer (“Why are you resubmitting?” / submission comment)

```
Fixed the issues from the previous reviews: (1) sign-in — a working email+password test account and a 24/7 demo agent are in the Test instructions; wrong credentials now show "Incorrect email or password" instead of a generic error; (2) privacy policy rewritten to cover data collection, use, storage/retention, sharing (AI model providers, hosting, Google, Sentry), international transfer, user rights and deletion: https://www.teamclu.ai/privacy-extension; (3) permissions reduced — no tabs permission, no install-time host access, no content script on all sites; page content is read only after the user approves in the side panel; error reporting is opt-in; (4) added screenshots and a clearer icon.
```

## 6. Before you press Submit

- [ ] Sign in once with the reviewer account in a fresh Chrome profile from outside mainland China and
      walk through §4 (record a screen capture). Check the agent actually calls the page tool in step 4.
- [ ] Keep the reviewer account, the `teamclaw-self-host-amuxd-1` container and the agent online for the
      whole review (3–14 days); no destructive deploys to the self-host stack meanwhile.
- [ ] Deploy the website PR so the policy URL serves the new text.
- [ ] Google OAuth consent screen (client `319909871659-…`, a project outside the gcloud account on the
      Mac mini) is “In production”, not “Testing”; otherwise hide Google sign-in for the review.
