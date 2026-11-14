# GPUI Kit spike — 1:1 Desktop home shell (throwaway)

**Goal:** the Desktop home + chat page (NavRail · 聊天列表 · 对话) rebuilt in
GPUI Kit at measured 1:1, plus **read-only** Cloud sessions.

Not production. Do not ship.

## Layout lock (measured from a 2x capture of Desktop at 1200 × 800 pt)

| Surface | Desktop | Spike (`theme::Layout`) |
|---|---|---|
| Nav rail | `--sidebar-width: 220px` | `NAV_W = 220` |
| Session list | `--session-list-width: 280px` | `SESSION_W = 280` |
| Window | 1200 × 800 | `WINDOW_W/H`, transparent titlebar, traffic lights at (19, 19) |
| Session row | 64 / 84 pt (+2 `my-px`) | `ROW_H`, `ROW_H_WITH_PARTS` |
| Chat header / gutter | 48 pt / 16 pt | `CHAT_HEADER_H`, `CHAT_PAD_X` |
| Colours | sampled from the capture | `theme::Calm` |

Vertical text bands and horizontal element positions agree within 1.5 pt in
every column. Pixel match is about 94% within 12/255; what remains is glyph
anti-aliasing and the user's photo avatar.

## Modules

| File | Desktop counterpart |
|---|---|
| `nav.rs` | `NavRail.tsx` + `NewChatSplitButton.tsx` + `LocalDaemonCard` |
| `session_list.rs` | `SessionListColumn.tsx` + `SessionLiquidGlass.tsx` |
| `chat.rs` | chat header, `ChatMessage`, `ComposerStack` live turn, `ChatInputArea` toolbar |
| `theme.rs` | `globals.css` + AGENTS.md, Lucide `icon()` helper |
| `demo.rs` | fixtures mirroring `compare/desktop.png`; `formatRelativeTime` port |
| `cloud.rs` | Cloud API read-only |

## GPUI notes

- Icons are real Lucide SVGs. Register `gpui_kit::assets::AllAssets`; the
  default `Assets` bundle only carries a subset (`users`, `sparkles`,
  `send`, … render blank with it).
- Desktop's mono stack falls through to `ui-monospace` (SF Mono), which has no
  public family name. The spike loads `/System/Library/Fonts/SFNSMono.ttf` and
  uses `.SF NS Mono`; it also sets the kit theme's mono font so inline code in
  markdown matches.
- Preview lines are one `StyledText` with highlight runs, so `text_ellipsis`
  truncates the whole line while `@mentions` stay coral.
- **No CSS `backdrop-filter`.** The selection pill is a solid card with a
  border and shadow, not a blur.
- **Selection Y is estimated** from row-height constants (no DOM measure).
- Agent markdown uses `gpui_kit::base::text::TextView` directly. The
  component `TextView` only forwards heading *size*, and base derives the
  gap above a heading from it, so Desktop's `.chat-md` margins can't be
  reached through it. The one gap still open is a list's outer `my-2`: base
  `list_style` styles the marker, not the list, so lists sit ~2.5pt tight.
- Code-block header ("text" + copy) goes through `code_block_actions`, which
  base pins at top-2/right-2; the row is sized from the chat column width.

## Live data

`run-live.sh` reads Desktop's WebKit localStorage (token, `teamclu:current-team`,
`teamclu-local-daemon-actor-id`) into `$TMPDIR/teamclu-spike-auth.env` (0600)
and runs the spike against the same Cloud API. It mirrors Desktop's reads:

- list: `GET /v2/sessions?kind=regular` (v1 `kind=regular` still includes app
  sessions);
- avatars: `GET /v1/sessions/{id}/participants`, mentionable actor types only,
  disc colour = `actorAvatarColor(actorId)`; a roster made only of you and the
  local agent shows no participants row (`isSoloWithLocalAgent`);
- thread: `GET /v1/sessions/{id}/messages` (newest page, ascending), opened
  pinned to the bottom (`anchorTo: "end"`).

No MQTT: previews and times are as of launch, so a session Desktop is
streaming into reads newer there.

## Screenshot compare gate

With Desktop and the spike both open at 1200 × 800 (Screen Recording granted):

```bash
bash compare/cmp.sh          # captures both windows → desktop.png, spike.png, cmp-*.png
python3 compare/bands.py list=236,420,0,800      # vertical text bands, Desktop vs spike
python3 compare/xbands.py hdr=500,1200,10,38,170,6   # horizontal element positions
swift compare/click.swift 350 160                # synthesize a click in the spike window
```

Do not claim a column “done” without a fresh pair in `compare/`.

## Run

```bash
cd prototypes/gpui-kit-spike
# demo:
CARGO_TARGET_DIR=/Volumes/openbeta/workspace/teamclaw/.cargo-target-gpui-spike cargo run
# live (Desktop must be signed in):
CARGO_TARGET_DIR=/Volumes/openbeta/workspace/teamclaw/.cargo-target-gpui-spike ./run-live.sh
```

Own `rust-toolchain.toml` (`stable` ≥1.100). Isolated cargo target (SDLC).
