# TeamClu — Chrome Web Store resubmission (v0.2.0)

Item: `nlmkpmokfbboonocdnngddbfpdedkfee` · Dashboard: https://chrome.google.com/webstore/devconsole

Background (rejections of 0.1.1): Aug 10 / Aug 14 “Red Potassium” (reviewer could not sign in),
“Purple Nickel” (privacy policy did not cover collection / use / storage / sharing), Aug 26 generic
Program Policies. This file is the exact text to enter; keep it in sync with
`apps/extension/manifest.json`, `apps/extension/_locales/*/messages.json` and
`docs/chrome-extension-privacy.md`.

The listing describes only user-initiated features that work today: side-panel chat and the
optional link button. Agent-initiated page reading (`get_page_dom` remote tool) is paused in the
daemon (`apps/daemon/src/daemon/server/remote_tools.rs`), so it is not described, not in the test
instructions, and `activeTab` is no longer requested. Re-add all three together if remote tools
come back.

## 1. Package

- Upload `teamclu-extension-0.2.0.zip`, built from main (`BUILD_ENV=production pnpm --filter
  @teamclu/extension build`, then zip `apps/extension/dist`). Version **0.2.0** (> 0.1.1).
- `permissions`: `sidePanel`, `scripting`, `storage`, `identity`.
- `optional_host_permissions`: `http://*/*`, `https://*/*` (nothing granted at install).
- Removed since 0.1.1: `tabs`, install-time `host_permissions` (`<all_urls>`), the static
  all-sites `content_scripts`. Also not requested: `activeTab`.
- Do **not** publish via a tag push: `release-extension.yml` only publishes on a manual dispatch
  with `brand=teamclu`, `publish=true`.

## 2. Store listing

- **Default language**: Chinese (China) — `default_locale` is `zh_CN`; English (`en`) also provided.
- **Name / summary**: from the package (`appName`, `extensionDescription`).
- **Description**: paste `storeDesc` from `_locales/zh_CN` (default) and `_locales/en` (English).
- **Category**: Productivity → Communication.
- **Icon**: `icon-128.png` (96 px artwork + 16 px transparent margin).
- **Screenshots** (1280×800, 24-bit, no alpha): `01-sign-in-{en,zh}.png`, `02-chat-{en,zh}.png`.
- **Homepage / support URL**: https://www.teamclu.ai

## 3. Privacy practices tab

**Single purpose**
```
TeamClu adds a Chrome side panel in which the user chats with their team and their team's AI agents, and can send a link from a site they chose (with that page as context) into the conversation.
```

**Permission justifications**

- `sidePanel`
  ```
  Shows the TeamClu chat UI in Chrome's side panel when the user clicks the toolbar button or the link button.
  ```
- `scripting`
  ```
  Registers the bundled link-button content script only on the sites the user added in Settings and granted access to (chrome.scripting.registerContentScripts). No remote code is injected; the script is packaged with the extension.
  ```
- `storage`
  ```
  Stores local settings in the browser (the link-button site list, privacy and error-report choices) and short-lived hand-off state between a page and the side panel when the link button is clicked.
  ```
- `identity`
  ```
  Used only for chrome.identity.launchWebAuthFlow to complete the optional "Sign in with Google" OAuth flow. No other Google data or API is accessed.
  ```
- Host permissions (optional: `http://*/*`, `https://*/*`)
  ```
  Declared as optional host permissions and NOT granted at install. Chrome asks the user only when they add a site to the link-button list in Settings, and then only for that site. The link button content script runs only on sites the user granted. Without a grant, the extension cannot access any page.
  ```

**Remote code**: **“No, I am not using remote code.”** All JavaScript (background, content script,
side panel) is bundled in the package; `sidepanel/index.html` loads only local scripts; there is no
`eval` / `new Function` in the build. The side panel only exchanges data (JSON over HTTPS, MQTT over
WSS) with the TeamClu API.

**Data usage — check:**

- [x] Personally identifiable information (email, name, Google profile picture)
- [x] Authentication information (password at sign-in, session tokens)
- [x] Personal communications (chat messages and attachments)
- [x] Website content (the link, its text and the page it is on, when the user clicks the link button and sends it)
- [x] Web history — conservative: the URL/title of that page is sent with it
- [ ] Health, Financial and payment information, Location, User activity — not collected
  (error reports are opt-in, off by default, and disclosed in the policy)

Certifications: check all three (not sold to third parties; not used or transferred for purposes
unrelated to the single purpose; not used or transferred to determine creditworthiness or for
lending).

**Privacy policy URL**: `https://www.teamclu.ai/privacy-extension` (live; shows “Last updated:
October 21, 2026”).

## 4. Test instructions

Username field: `chrome-review@teamclaw-dev.ucar.cc` · Password field: `<PASSWORD>`
(the password is entered only in the dashboard, nowhere else).

Additional instructions:
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
3. You are in the team "Chrome Review Demo" with its agent "Chrome Review Daemon", which runs on our server 24/7. Click "New Chat" and send "Hello" — the agent replies within about 10-20 seconds. The model selector at the bottom of the chat box should show "deepseek-v4-pro"; if it shows anything else, open it, scroll to the end of the list and choose "deepseek-v4-pro" (the team's model).
4. Link button: open Settings (gear icon) → General → "Page quick-open button", add "wikipedia.org" and click "Allow" in Chrome's site-access prompt (only that site is requested). Open https://en.wikipedia.org/wiki/Collaborative_software, hover any link in the article and click the small TeamClu button next to it. The side panel opens a new chat for that link with the link in the chat box; add e.g. "Summarize this link" and press Send — the agent replies.
5. No site access is granted at install, and nothing from a page is sent before you click the link button and press Send. Settings → General → Privacy lets you switch error reports on/off (off by default).

If anything fails, contact contact@teamclu.ai.
```

## 5. Note to reviewer (submission comment)

```
Fixed the issues from the previous reviews: (1) sign-in — a working email+password test account and a 24/7 demo agent are in the Test instructions; wrong credentials now show "Incorrect email or password" instead of a generic error; (2) privacy policy rewritten to cover data collection, use, storage/retention, sharing (AI model providers, hosting, Google, Sentry), international transfer, user rights and deletion: https://www.teamclu.ai/privacy-extension; (3) permissions reduced — no tabs or activeTab permission, no install-time host access, no content script on all sites; site access is requested only for sites the user adds for the link button; error reporting is opt-in; (4) store description now lists only the features in this version; added screenshots and a clearer icon.
```

## 6. Before you press Submit

- [x] Reviewer accounts sign in (API and side panel, 2026-10-21); "Hello" answered in ~10 s with
      team/deepseek-v4-pro. The account's remembered model is deepseek-v4-pro (a brand-new account
      would default to opencode "Claude Fable 5", which fails with a provider 401).
- [ ] Walk through §4 once in a fresh Chrome profile from outside mainland China (record a screen
      capture) — especially the link button in step 4, which needs Chrome's site-access prompt.
- [ ] Keep the reviewer accounts, the `teamclaw-self-host-amuxd-1` container and the agent online for
      the whole review (3–14 days); no destructive deploys to the self-host stack meanwhile.
- [ ] Google OAuth consent screen (client `319909871659-…`) is “In production”, not “Testing”;
      otherwise hide Google sign-in for the review.
