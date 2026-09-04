# AGENTS.md — UI / Visual Design Spec (Web / Desktop)

This file is the source-of-truth for the **web / desktop** visual language
(`packages/app/`). For the **iOS client** (`apps/ios/`) the source-of-truth is
`apps/ios/DESIGN.md` (the Hai 灰 / wabi-sabi system) — don't apply the rules
below to iOS work. For repo conventions (architecture, commands, release
process) see `CLAUDE.md`. If `SDLC.md` exists at the repo root of this
checkout, read it before starting changes; it is a local, git-ignored SDLC
override for this workspace.

The web/desktop design direction is **"Editorial Calm"** — paper-feel
neutrals, brand coral used only as small accents, Chinese-first typography,
higher information density than a typical chat app but with breathing room
inside each card.

It came from the Claude Design handoff at
`https://api.anthropic.com/v1/design/h/OLWqffBkDMYRHp_p7cFRNg` (Direction B).
The local prototype copy lives in `/tmp/design-OLWqff/` when fetched.

> **Git note:** Work on a task-scoped branch, never on `main`, and never push
> to `main` directly. See `CLAUDE.md` → Git Workflow for the full rule. If
> `SDLC.md` exists at the repo root of this checkout, it may add personal
> worktree / preview-integration conventions on top.
>
> **PR rule:** Do **not** push the branch or run `gh pr create` on your own
> initiative. Until the user explicitly says "open the PR" / "ship it" /
> "提 PR", stop after committing and report back — even if everything looks
> "done", tests pass, and the user previously approved the diff.

---

## 1. Design tokens

All tokens live in `packages/app/src/styles/globals.css` and are exposed to
Tailwind via `@theme inline`. Use the token, not a hardcoded color.

### Color palette (light — primary theme)

| Token              | Value                       | Use                                                          |
| ------------------ | --------------------------- | ------------------------------------------------------------ |
| `--background`     | `#fbfaf7`                   | App background / chat pane                                   |
| `--paper`          | `#ffffff`                   | Cards, message surfaces, popovers                            |
| `--panel`          | `#efece4`                   | Sidebar / sub-panel surface                                  |
| `--selected`       | `#e7e2d6`                   | Selected row in panel sections                               |
| `--foreground`     | `#1a1a14`                   | Primary ink                                                  |
| `--ink-2`          | `#3d3c34`                   | Secondary ink (body copy)                                    |
| `--muted-foreground` | `#75736a`                 | Tertiary / hint text                                         |
| `--faint`          | `#a8a6a0`                   | Quiet ink — timestamps, meta, divider labels                 |
| `--border`         | `rgba(26,26,20,0.08)`       | Standard line                                                |
| `--border-soft`    | `rgba(26,26,20,0.05)`       | Internal card divider, dashed dividers                       |
| `--coral`          | `#e85a4a`                   | **Brand accent — used sparingly**                            |
| `--coral-soft`     | `#f5d6cf`                   | Coral on coral, e.g. permission popover background           |

Dark mode keeps the existing oklch values; only coral and font tokens are
extended there. Light is the canonical theme.

### Where coral is allowed

Coral is the brand accent. Use it for **at most 2 spots in any frame**.
Approved locations:

- Active session left bar (2px wide)
- Unread / new-message badge background
- Primary send button (chat input)
- Small "AI" pill border, when used in a row of mixed actors
- AI-avatar ring + tiny indicator dot (lobster mark on agent rows)
- Permission popover border / pill (when re-introduced)

If you find yourself reaching for coral for anything else (success state,
focus ring, link, hover), use ink/muted/border instead.

### Typography

```
--font-sans: "PingFang SC", "Noto Sans SC", "Source Han Sans SC",
             -apple-system, BlinkMacSystemFont, "Microsoft YaHei",
             system-ui, sans-serif
--font-mono: "JetBrains Mono", "SF Mono", ui-monospace, Menlo,
             Consolas, monospace
```

Chinese-first. Latin glyphs fall back to system. **Use mono for:**
timestamps, tool-call argument strings, model identifiers, version
numbers, keyboard hint pills (`⌘↵`, `↵`, `esc`).

### Type scale

| Size                 | Use                                                |
| -------------------- | -------------------------------------------------- |
| `text-[15px]` (700)  | Section title (e.g. "会话")                        |
| `text-[13.5px]`      | Message body, chat bubble text                     |
| `text-[13px]` (600)  | Card title (conversation row, agent name)          |
| `text-[12.5px]`      | Secondary body, agent reply text                   |
| `text-[12px]`        | Card preview, meta line                            |
| `text-[11.5px]`      | Footer captions                                    |
| `text-[11px]` (mono) | Timestamps, version, "⌘↵"                          |
| `text-[10.5px]` (600, uppercase, tracking-wide) | Group dividers ("今天", "团队") |
| `text-[9.5px]` (mono, 600) | Brand "AI" pill                              |

### Radii

- Section / panel: 14px
- Card / message bubble (large side): 16px (small corner 6px on speaker side)
- Buttons / pills: 7–8px
- Inline chips, mono key pills: 3–4px
- Tool-call card: 8px

### Spacing rhythm

- Sidebar item vertical pad: `7px 9px`
- Chat thread item gap: `8–12px`
- Card internal pad: `10–14px`
- Section header pad: `14–16px`

Density tip: prefer tightening row pad and font-size before reaching for
abbreviations. The design intentionally fits more on screen than a typical
SaaS chat tool.

---

## 2. Layout — three-column shell

```
┌─────────┬──────────────┬───────────────────────────────────┐
│         │              │  Chat header (title + meta)       │
│ Sidebar │ Session list │  ────────────────────────────     │
│ (panel) │  (paper bg)  │  Thread (paper bg)                │
│         │              │  ────────────────────────────     │
│         │              │  Input bar (paper card)           │
└─────────┴──────────────┴───────────────────────────────────┘
```

### Window chrome

The sidebar header strip carries macOS traffic lights on the left and the
brand label (`TeamClu · workspace`) right-aligned. **Never** put a logo
glyph in this strip. Traffic lights are real (native), not faked.

### Sidebar (panel)

Background: `--panel` (`#efece4`).

Top-level structure:

1. **Window chrome** (traffic lights + brand)
2. **Quick-link list** — Sessions / @Mentions / Awaiting me / Pinned, each
   with a count on the right.
3. **Collapsible groups** — "想法 · N", "团队 · N". Use `▾` chevron with a
   transform animation; each group exposes a small `+` action.
4. **Footer** — settings link left, version right (`v2.4.1` in mono).

Group header style: `text-[10.5px]`, weight 600, uppercase, letterspacing
0.8, color `--faint`. Counts use mono `· N`.

### Session list (paper)

Background: `--background`.

Header: section title + count badge + search/edit icons on the right.

**Cards group by date dividers**: 今天, 昨天, 本周, 更早. The divider
itself is small uppercase faint text with a mono count: `今天 · 4`.

Card anatomy (12×16 padding, no card border):

```
[📌]  Title here, truncated single line          19:47 ←mono, faint
       Two-line preview text, ellipsised on the
       second line if necessary.
       [avatar cluster, -5px overlap]  3 位     [2] ←coral unread
```

Active card: paper-white background (`--paper`) + 2px coral left border.
Non-active: transparent background, no left border. Hover: very subtle
darken of background — do not introduce shadows.

### Chat pane

Background: `--background`.

Header: title (`text-[15px]` 700) + meta line below (`3 位参与者 · 12
条消息 · 19:47 更新`) + tag chips inline next to title + icon actions on
the right. Tag chips: small paper-bg pills with border, `text-[10.5px]`.

Thread: padded `4px 26px`, justify-content flex-end (messages stick to the
bottom).

---

## 3. Message types

There are three kinds of message rows. **Thinking and Permission Request
are currently disabled** — the user removed them. The components stay in
the codebase for future revival, but no live thread renders them.

### User message

Right-aligned column. Above the bubble: speaker name + tiny avatar (16px).
For self ("你"), use the dark ink bubble (`bg: --foreground`, text
`#fefdfa`). For others, use paper bubble with border.

Bubble: `max-w-[65%]`, padding `10px 14px`, radius `16px` with
`borderBottomRightRadius: 6px` (the "speaker corner"). Font 13.5px / 1.6.

### Tool call card

Indent `33px` from the avatar gutter. Two rows inside a 8px-radius paper
card:

```
● tool  tool_name(arg: "value", ...)        ok · 0.4s
→ result text, truncated on the right
```

Everything in mono, 11.5px. Status dot color: success `#2eb872`, error
`var(--destructive)`, pending `#e8b54a`. Top row has a faint bg
(`#fbf9f4`); bottom row is paper.

### Agent reply (the "note")

This is the most important visual decision: AI replies are **not bubbles**.
They are notes, structured like a memo:

1. Avatar + name + AI badge (subtle outline variant) + model · time (mono,
   faint) + copy/refresh icons on the right.
2. Body paragraph (13.5px / 1.7, ink).
3. Optional bullet grid: dashed top border, two-column `auto 1fr` grid,
   muted labels in column 1, ink values in column 2.
4. Optional follow-up pills: paper bg, border, 12px text, 8px radius. Wrap.

Indentation: 33px gutter aligns body under avatar column.

---

## 4. Chat input

The composer is a paper card with `box-shadow: 0 4px 16px -10px
rgba(20,20,15,0.1)` and 14px radius.

Top zone: textarea. Bottom zone separated by a `--border-soft` 1px line.

Bottom row layout:

```
[Agent pill ▾] [📎] [@] [✨]    ⌘↵   [发送 →]  ←coral primary
```

- Agent pill is left-most: small avatar + agent name + chevron. Background
  `--panel`, padding `4px 9px`, radius 7px.
- Icon affordances: paperclip, at-sign, sparkle — these map to file insert,
  mention, command in the existing component.
- Right side: `⌘↵` hint in mono `text-[11px]` faint, then the send button.
- Send button: `bg-coral text-white`, padding `6px 14px`, radius 8px, weight
  600. Disabled state: opacity 0.4, no color change.

---

## 4.5 Actor avatars — letter discs with stable colors

Actors don't carry an avatar color in the data model, so the letter-fallback
disc takes its color from `actorAvatarColor(actorId)` in
`packages/app/src/lib/actor/actor-color.ts`. Same actor → same color across the app.

The palette is intentionally saturated-but-muted (coral, violet, green,
amber, blue, plum, teal, olive, terracotta, slate). The disc renders the
display-name's first letter in white. **Don't fall back to `bg-muted` gray
— it makes the actor strip look dead.** When `display_name` is empty, fall
back to a Sparkles/User icon, still on the colored disc.

For agent (AI) actors, render the disc as a small rounded square (`rounded`,
not `rounded-full`) so the type difference is legible at 20px without a
text badge. Human actors stay as circles with the green online dot in the
bottom-right corner.

## 5. AI presence — "quiet but legible"

The user-facing rule is "适度区分 — 清晰但不抢眼". Concretely:

- **Don't** put the lobster logo in the window chrome. Don't put any glyph
  there. The mark is implicit.
- **Do** ring AI-actor avatars with a 1.5px coral ring + a tiny coral dot
  bottom-right (the agent indicator). Human avatars get a green online dot
  in the same position when online.
- **Do** tag AI rows with a small "AI" pill — outlined coral variant in
  sidebar lists, filled coral on first appearance in a thread.
- **Don't** apply coral to any AI text content. The text reads as normal
  ink; only the meta strip gets coral.

---

## 6. Implementation notes

- Tailwind classes available for the new tokens: `bg-coral`, `text-coral`,
  `bg-paper`, `bg-panel`, `text-faint`, `font-sans`, `font-mono`. Use these
  instead of arbitrary `[--foo]` syntax when possible.
- The prototype hardcodes `style={{ ... }}` for many tight values (5px,
  9.5px font-size, etc). Match those when porting — don't round to the
  nearest Tailwind step.
- For Chinese-only labels, retain the prototype's wording (e.g. "会话",
  "想法", "团队", "等待我"). For mixed-locale strings, use the existing
  `t()` keys. Don't invent en-US placeholders.
- When you add a new surface, ask: which token does this read as — paper,
  panel, background, or selected? If you can't answer, you probably need a
  new token; raise it before adding ad-hoc colors.

### Which state is shared between windows

**Default: window-local.** Every workspace window and the local-agent panel gets
its own store graph and its own `MqttLiveWiring`. A store's state is not
promised to be consistent across windows, and does not need to be.

**The one exception is auth.** `lib/auth/session-store.ts` syncs the session
across windows over a `BroadcastChannel`, because "one window signed out while
another still holds a token" is a security problem, not a cosmetic one.

**Everything persisted today is a preference, and last-writer-wins is fine for
it.** Five stores use the zustand `persist()` middleware —
`agent-default-workspace-store`, `agent-model-pick-store`,
`automation-default-model`, `client-model-mru`,
`offline-send-preference-store` — and a few more hand-roll the same thing over
`localStorage` (`header-preferences-store`, `git-settings`). The cost of another
window overwriting any of them is that the user picks again.

**So a new `localStorage.setItem` is a preference by default.** If a value
cannot tolerate last-writer-wins, it does not belong in `localStorage` — raise
it instead of reaching for a `BroadcastChannel`. Making cross-window
consistency the default would decide, for every value, a question nobody asked.

See [ADR-0012](docs/adr/0012-window-local-state-is-the-default.md). It also
records which values are worth promoting to device-shared state (current team,
agent default workspace) — one at a time, each argued on its own.

### `packages/app/src/lib` layout

`lib/` is one directory per domain. Put a new module in the domain it belongs
to; only genuinely domain-free primitives live at `lib/` root, and there are
seven of them (`utils`, `store-utils`, `base64`, `lazy-component`,
`shared-module-lease`, `i18n`, `locale`). If a new file seems to have no
domain, that is usually a sign it is doing two things.

    actor/        who is speaking — identity, colours, presence, mentions
    agent/        agent identity, model choice, runtime reachability and state
    apps/         the Apps feature (deploy, data browser, app sessions)
    attachments/  upload, download, image handling
    auth/         sign-in, token storage, OAuth
    backend/      the Cloud API client (see §7)
    cache/        the local libsql mirror of Cloud API rows
    clawhub/      skill registry types
    config/       build config, server config, feature flags, platform, version
    cron/         desktop-scheduled jobs
    daemon/       every call into amuxd: discovery, RPC, workspaces, admin
    diagnostics/  redaction, probes, the diagnostics bundle, debug logs
    dynamic-ui/   agent-authored UI descriptions
    e2e/          the tauri-mcp harness surface
    embed/        the embedded/side-panel chat mode
    extension/    the browser extension — incl. link-hover + link-session,
                  which apps/extension compiles too (see the guard test there)
    history/      version history providers
    knowledge/    knowledge tree, wiki links, Obsidian compatibility
    messages/     message rows, inbox, outbox display, send-path selection
    mqtt/         broker bridges (Tauri / browser / worker) and diagnostics
    opencode/     opencode config + templates
    proto/        generated protobuf
    remote-tools/ tools an agent can drive in the user's browser
    roles/        role markdown + role skills
    session/      sessions: create, list, resolve, fork, permissions, workspace
    session-export/  transcript export
    skills/       skill discovery, frontmatter, auto-follow
    stream/       the streaming pipeline — deltas, persistence, recovery
    sync/         Cloud API ⇄ local-cache row sync
    tabs/         tab models
    team/         teams, invites, permissions, skill paths
    teamclu/      agent runtime protocol (ACP permissions, runtime commands)
    telemetry/    Sentry, scoring, usage, startup timing
    terminal/     PTY client
    ui/           presentation helpers with no domain of their own
    workspace/    workspace paths, gitignore, desktop file reads
    workspace-seed/  first-run workspace instructions

`lib/__tests__/` keeps the tests that span domains (or test a root module);
everything else lives in its domain's own `__tests__/`.

### Supabase schema changes

- For any live Supabase schema/RLS/RPC change, use the configured Supabase
  MCP first. Do not silently switch to `supabase db push`, `psql`, REST
  calls, or ad-hoc scripts when the user asked for MCP.
- If the Supabase MCP is not exposed in the current Codex tool list, or it is
  configured but unusable because auth is unsupported/missing, say that
  explicitly and stop for MCP setup instead of pretending the live database
  was changed.
- Keep the matching migration and pgTAP test under `services/supabase/` even
  when applying the same SQL through MCP, so local and live schemas do not
  diverge.
- After applying via MCP, verify the changed columns/functions/policies with
  a read-only MCP query before telling the user the live schema is updated.

---

## 7. Backend access boundary — Cloud API is the only client backend

**`cloud_api` is the only backend kind for clients. The `supabase` and `pocketbase` backend kinds have been removed from `packages/app/`; direct `@supabase/supabase-js` usage in client code is forbidden and enforced by a guardrail test (`packages/app/src/lib/backend/__tests__/no-supabase-import.test.ts`).**

The API contract is defined in `docs/openapi/teamclu-api.v1.yaml`. All business data operations must go through the TeamClu Cloud API (`/v1`) rather than direct Supabase client calls.

The Cloud API facade (`services/fc/lib/business-api.mjs`) is the canonical entry point for teams, sessions, messages, and invite operations. Clients (Tauri, Expo, iOS, daemon) should use their respective Cloud API providers:

- **Web/Desktop** (`packages/app/`): `CloudApiProvider` in `packages/app/src/lib/backend/provider.ts`
- **Expo** (`apps/expo/`): `createCloudSessionsApi` in `apps/expo/src/features/sessions/cloud-api.ts`
- **iOS** (`apps/ios/`): `CloudAPIClient` / `CloudAPIRepositories` in `apps/ios/Packages/AMUXCore/Sources/AMUXCore/CloudAPI/`
- **daemon** (`apps/daemon/`): `cloud_api` backend module in `apps/daemon/src/backend/cloud_api.rs`

Direct Supabase client usage (e.g. `supabase.from('sessions').select()`) is **reserved for internal FC repository implementation only** (`services/fc/lib/supabase-repo.mjs`). The FC facade forwards caller bearer tokens to Supabase, preserving RLS and auth semantics. The deprecated `supabase` backend kind in client config files is a legacy fallback — do not use it for new deployments.

**When adding new business endpoints:**

1. Define the endpoint in `docs/openapi/teamclu-api.v1.yaml` first.
2. Implement the repository contract in `services/fc/lib/repository-contract.mjs`.
3. Add the route handler in `services/fc/lib/business-api.mjs`.
4. Implement the Supabase passthrough in `services/fc/lib/supabase-repo.mjs`.
5. Add tests in `services/fc/test/` (route, repository, contract).
6. Wire the endpoint into client Cloud API providers.

Do not bypass the Cloud API and call Supabase directly from client code. The facade exists so future backend replacements (MySQL, other storage) happen inside FC without client rewrites.

---

## 8. Out-of-scope (yet)

These were prototyped but explicitly removed by the user. Keep the code
paths in place but do not render them in the main thread:

- **Thinking** block (italic, dashed-side-bar reasoning summary).
- **Permission request** popover anchored to the input bar (Codex-style).

When the time comes to re-introduce these, follow the prototype shapes in
`/tmp/design-OLWqff/teamclu-v2/project/direction-b.jsx` —
`BThinking` and `BPermissionPopover`.

Also future work, listed here so the team has it:

- **Unread count badge** on the conversation card. The local schema does
  not track read state today (no `last_viewed_at` / `read_marker` column;
  no Supabase column either). Requires (a) a new column on `sessions` or a
  side `session_read_marker` table, (b) a writer hook on session-activate,
  (c) sync wiring, (d) UI render. The card already reserves the right-edge
  slot for it; see `renderSessionItem` in `SessionListColumn.tsx`.
- **Pagination beyond 50 rows — done.** `useSessionListStore` pages by
  cursor (`loadFirstPage` / `loadMore`, 50 per page, `hasMore` / `nextCursor`
  tracked per list kind) and `SessionListColumn` renders the Load-more button
  (`sidebar.loadMoreSessions`). Listed here so nobody re-plans it.
- **Realtime participant invalidation.** `participantsBySession` in
  `SessionListColumn` is loaded lazily and never invalidated. When the
  realtime envelope handler in `App.tsx` sees `session_participant`
  changes, it should poke this cache. Today the user gets stale avatars
  until the column remounts.
- **Drop the dual-store legacy layer.** `useSessionStore.sessions` is no
  longer the source of truth for the list (the column reads
  `useSessionListStore.rows`), but it still feeds `pinnedSessionIds`,
  `highlightedSessionIds`, `activeSessionId`, and the activity badges.
  Migrating those onto the v2 store and dropping the legacy field would
  remove the redundancy the user flagged.

<!-- seahelm:suggest:start -->
## Quick options for the user (seahelm)

When you finish a turn and can anticipate the user's likely next steps, end your
reply with one final plain-text line formatted exactly as:

    ::seahelm-suggest:: first option | second option

Give 2-5 short imperative phrases separated by ` | `. seahelm turns that line into
clickable buttons for the user. Make it the LAST line of your message; do NOT run
a tool or shell command to produce it.
<!-- seahelm:suggest:end -->

<!-- seahelm:worktree:start -->
## Moving into another worktree (seahelm)

seahelm draws one card per git worktree, and your pane is filed under the one it
started in. If you move into a different worktree and start working there, say so:

    seahelm pane move "$SEAHELM_PANE_ID" <absolute-worktree-path>

Your pane — and everything running in it — moves to that worktree's card, instead
of a stray empty pane appearing there while you keep reporting under the old one.

Only when you actually work in it. Creating a worktree you do not move into needs
nothing. seahelm often notices on its own; saying it means it is never missed.
<!-- seahelm:worktree:end -->
