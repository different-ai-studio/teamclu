---
name: open-computer-use
description: "Control local desktop applications on macOS, Windows, and Linux with the open-computer-use MCP tools: list apps, read the accessibility tree, click, type, scroll, drag, and press keys. Trigger words: open app, operate app, control computer, click, type, scroll, switch window, 打开应用, 操作应用, 点击, 输入, 滚动. Note: NEVER invoke this skill for opening web pages or operating page content — use playwright or chrome-control. Do not use osascript, AppleScript, autoui, or auto_* tools."
compatibility: "open-computer-use MCP server. macOS 14 or later; Windows and Linux use their platform runtimes. Requires Accessibility and Screen Recording on macOS."
---

# Open Computer Use

Desktop applications go through the `open-computer-use` MCP tools. Web pages do not.

## When to use

Use this skill for native and desktop apps: Finder, System Settings, TextEdit, Notes, Slack, WeChat, VS Code, and other installed applications.

Use `playwright` or `chrome-control` for web page content: opening a URL, reading a page, filling a form, clicking a link inside a site. Driving the browser's own window chrome (the app, not the page) is still this skill.

## Workflow

1. Call `list_apps` and pick the app from that list.
2. Call `get_app_state` for that app. Act on `element_index` values from this result.
3. Prefer `set_value` for editable controls, then `click`, `press_key`, `scroll`, and `perform_secondary_action`.
4. Use a coordinate `click`, `scroll`, or `drag` only when the tree has no element for the target.
5. After the UI changes, call `get_app_state` again. Do not reuse an `element_index` from an older snapshot.

On macOS, `query` finds a control by text or role without rendering the whole tree, and `select_text` selects text inside a text element. Windows and Linux do not expose those two tools.

## Permissions

macOS needs Accessibility and Screen Recording, granted to the Computer Use app. If a call fails with a permission error, tell the user to launch `open-computer-use` once and approve the prompts. Do not keep retrying.

Windows and Linux only work inside the logged-in desktop session.

## Guardrails

- Ask before sending, deleting, purchasing, approving, uploading, or any other action that leaves the machine.
- Do not inspect password managers or unrelated private apps unless the user asked for that task.
- Do not type a password unless the user provided it for this task.
- Do not turn on global pointer fallback. It moves the user's real cursor.
- Do not use `browser_*` tools on desktop apps. They only affect web pages.
- Do not use `auto_*` tools, `osascript`, or AppleScript for desktop control.
