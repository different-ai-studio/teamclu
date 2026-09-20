# TeamClu Privacy Policy

*Last updated: August 6, 2026*

TeamClu is a browser extension that shows an AI chat side panel and lets you send the content of a web page you are viewing to a TeamClu agent. This policy explains what data the extension handles and how.

## What we handle

- **Web page content** — the text, DOM, and any selected text of a page, captured *only* when you explicitly invoke TeamClu (for example by opening the side panel for the page or sharing a link). The extension does not passively read or collect your browsing across sites.
- **Extension settings** — your preferences (such as per-site link-hover settings) are stored locally in your browser via the extension `storage` API.

## How it is used

Page content you choose to share is sent to the TeamClu agent backend so the agent can respond to your request. It is used solely to provide the chat functionality you asked for. We do **not** sell or transfer your data to third parties, do not use it for any purpose unrelated to the extension's single purpose, and do not use it to determine creditworthiness or for lending.

## Permissions

- `sidePanel` — renders the TeamClu chat interface.
- `activeTab` / host access — reads the current page's content when you invoke the extension.
- `scripting` — injects the content script that extracts page content.
- `tabs` — identifies the active tab and opens/navigates URLs you share with the agent.
- `storage` — stores your settings locally in the browser.
- `identity` — runs Google OAuth sign-in via `chrome.identity.launchWebAuthFlow` (PKCE redirect capture only; no background identity monitoring).

## Data retention

Settings remain in local browser storage until you remove the extension or clear them. Shared page content is processed to fulfil your request and is not retained beyond what is needed to operate the service.

## Contact

Questions about this policy: [weigan.huang@gmail.com](mailto:weigan.huang@gmail.com)
