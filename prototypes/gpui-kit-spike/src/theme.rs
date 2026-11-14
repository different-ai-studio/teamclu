//! Editorial Calm + Desktop layout lock, sampled from a 2x capture of the
//! running Desktop window (`compare/desktop.png`, 1200×800 pt).
//! Spike only — GPUI has no CSS backdrop-filter; glass is an approximation.

use gpui_kit::{hsla, px, rgb, svg, Hsla, IntoElement, Pixels, Styled};

pub struct Calm {
    pub nav_bg: Hsla,
    pub list_bg: Hsla,
    pub chat_bg: Hsla,
    pub paper: Hsla,
    pub panel: Hsla,
    pub foreground: Hsla,
    pub ink_2: Hsla,
    pub muted: Hsla,
    pub faint: Hsla,
    pub border: Hsla,
    pub border_soft: Hsla,
    pub ring: Hsla,
    pub coral: Hsla,
    pub coral_cta: Hsla,
    pub coral_soft: Hsla,
    pub coral_fg: Hsla,
    pub user_bubble: Hsla,
    pub user_bubble_rule: Hsla,
    pub turn_body_bg: Hsla,
    pub subtle_row: Hsla,
    pub code_bg: Hsla,
    pub online: Hsla,
    pub tool_ok: Hsla,
    pub tool_error: Hsla,
}

impl Calm {
    pub fn light() -> Self {
        Self {
            nav_bg: rgb(0xedebe6).into(),
            list_bg: rgb(0xf7f6f2).into(),
            chat_bg: rgb(0xfaf9f6).into(),
            paper: rgb(0xffffff).into(),
            panel: rgb(0xedebe6).into(),
            foreground: rgb(0x191914).into(),
            ink_2: rgb(0x3d3c34).into(),
            muted: rgb(0x75736a).into(),
            faint: rgb(0xa8a6a0).into(),
            border: hsla(0.1, 0.05, 0.1, 0.08),
            border_soft: hsla(0.1, 0.05, 0.1, 0.05),
            ring: hsla(0.0, 0.0, 0.0, 0.05),
            coral: rgb(0xe85a4a).into(),
            coral_cta: rgb(0xe55041).into(),
            coral_soft: rgb(0xfadcd9).into(),
            coral_fg: rgb(0xffffff).into(),
            user_bubble: rgb(0xe5eaf0).into(),
            user_bubble_rule: rgb(0xd9dee3).into(),
            turn_body_bg: rgb(0xfcfbf8).into(),
            subtle_row: rgb(0xfaf9f6).into(),
            code_bg: hsla(0.1, 0.05, 0.1, 0.05),
            online: rgb(0x16b46c).into(),
            tool_ok: rgb(0x2eb872).into(),
            tool_error: rgb(0xd94c3f).into(),
        }
    }
}

/// Desktop App.tsx CSS vars + measured positions (pt).
pub struct Layout;
impl Layout {
    /// `--sidebar-width` in App.tsx
    pub const NAV_W: f32 = 220.;
    /// `--session-list-width` in App.tsx
    pub const SESSION_W: f32 = 280.;
    pub const WINDOW_W: f32 = 1200.;
    pub const WINDOW_H: f32 = 800.;

    pub const NAV_PAD_X: f32 = 10.; // px-2.5
    pub const NAV_TOP_STRIP_H: f32 = 48.;
    pub const NAV_ENTRY_H: f32 = 33.;
    pub const NAV_ICON: f32 = 15.;
    pub const CTA_H: f32 = 39.;
    pub const CTA_RADIUS: f32 = 10.;
    pub const CTA_ADVANCED_W: f32 = 36.; // w-9

    pub const SESSION_HEADER_H: f32 = 48.;
    pub const SESSION_PAD_X: f32 = 7.;
    pub const SESSION_PAD_TOP: f32 = 7.;
    pub const ROW_H: f32 = 64.;
    pub const ROW_H_WITH_APP: f32 = 80.;
    pub const ROW_H_WITH_PARTS: f32 = 84.;
    pub const ROW_GAP: f32 = 2.; // my-px on both sides
    pub const GLASS_RADIUS: f32 = 11.;
    pub const GLASS_RADIUS_MOVING: f32 = 12.;

    pub const CHAT_HEADER_H: f32 = 48.;
    pub const CHAT_PAD_X: f32 = 16.;
    pub const BUBBLE_RADIUS: f32 = 16.;
    pub const BUBBLE_SPEAKER: f32 = 6.;
    pub const COMPOSER_RADIUS: f32 = 14.;
}

/// Type scale (AGENTS.md + component classes).
pub struct Type;
impl Type {
    pub fn body() -> Pixels {
        px(13.5)
    }
    pub fn nav() -> Pixels {
        px(13.)
    }
    pub fn card_title() -> Pixels {
        px(13.)
    }
    pub fn secondary() -> Pixels {
        px(12.5)
    }
    pub fn preview() -> Pixels {
        px(12.)
    }
    pub fn mono() -> Pixels {
        px(11.)
    }
}

pub const FONT_SANS: &str = "PingFang SC";
/// Registered from `/System/Library/Fonts/SFNSMono.ttf` at startup.
pub const FONT_MONO: &str = ".SF NS Mono";

/// Lucide glyph from the gpui-kit asset bundle — same icon set Desktop
/// imports from `lucide-react`.
pub fn icon(name: &str, size: f32, color: Hsla) -> impl IntoElement {
    svg()
        .path(format!("icons/{name}.svg"))
        .size(px(size))
        .flex_shrink_0()
        .text_color(color)
}

const ACTOR_PALETTE: &[u32] = &[
    0xe85a4a, 0x7a6cf5, 0x3a8f63, 0xc98a3c, 0x3a6dbf, 0xa5527c, 0x1f8b94, 0x6a7a3a, 0xb56042,
    0x5a6a7a,
];

/// Port of `lib/actor/actor-color.ts` `actorAvatarColor`: djb2 over UTF-16
/// units with JS `| 0` wrap, then `Math.abs`.
pub fn actor_avatar_color(key: &str) -> u32 {
    let mut h: i32 = 5381;
    for unit in key.encode_utf16() {
        h = (h << 5).wrapping_add(h).wrapping_add(i32::from(unit));
    }
    ACTOR_PALETTE[(h.unsigned_abs() as usize) % ACTOR_PALETTE.len()]
}

pub fn actor_disc_color(name: &str) -> u32 {
    actor_avatar_color(name)
}

pub fn actor_letter(name: &str) -> String {
    name.chars()
        .next()
        .map(|c| c.to_uppercase().to_string())
        .unwrap_or_else(|| "A".into())
}
