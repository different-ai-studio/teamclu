//! Chat pane 1:1 — header actions, thread (agent prose + user bubble), and
//! ComposerStack (live agent turn docked on the input card).

use crate::cloud::{BubbleKind, LiveStep, LiveTurn, MessageRow, ToolCallRow, ToolStatus};
use crate::demo::message_clock;
use crate::theme::{actor_letter, icon, Calm, Layout, Type, FONT_MONO, FONT_SANS};
use gpui_kit::component::h_flex;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::base::text::{CodeBlock, TextView, TextViewStyle};
use gpui_kit::component::v_flex;
use gpui_kit::component::StyledExt;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

pub struct ChatProps<'a> {
    pub title: &'a str,
    pub messages: &'a [MessageRow],
    pub live: Option<&'a LiveTurn>,
    pub live_open: bool,
    pub agent_name: &'a str,
    pub composer: &'a Entity<InputState>,
    pub thread_scroll: &'a ScrollHandle,
    /// Chat column width; code-block headers span the block from base's
    /// fixed actions slot, so they need it.
    pub thread_w: f32,
}

pub fn render_chat<T: 'static>(
    calm: &Calm,
    props: ChatProps<'_>,
    cx: &mut Context<T>,
    on_toggle_live: impl Fn(&mut T, &mut Context<T>) + 'static,
) -> impl IntoElement {
    v_flex()
        .id("chat")
        .flex_1()
        .min_w_0()
        .h_full()
        .bg(calm.chat_bg)
        .font_family(FONT_SANS)
        .child(render_header(calm, props.title))
        .child(
            v_flex()
                .id("thread")
                .flex_1()
                .min_h_0()
                .px(px(Layout::CHAT_PAD_X))
                .pb(px(43.))
                .overflow_y_scroll()
                .track_scroll(props.thread_scroll)
                // Grows only while the thread is shorter than the viewport, so
                // short threads stick to the bottom (Desktop `justify-end`)
                // without making overflowing content unscrollable.
                .child(div().flex_grow(1.))
                .children(render_thread(
                    calm,
                    props.messages,
                    props.thread_w - Layout::CHAT_PAD_X * 2.,
                )),
        )
        .child(render_composer_stack(calm, &props, cx, on_toggle_live))
}

fn render_header(calm: &Calm, title: &str) -> impl IntoElement {
    let action = |name: &'static str| {
        div()
            .size(px(26.))
            .rounded_md()
            .flex()
            .items_center()
            .justify_center()
            .hover(|s| s.bg(hsla(0.0, 0.0, 0.0, 0.04)))
            .child(icon(name, 15., calm.ink_2))
    };
    h_flex()
        .w_full()
        .h(px(Layout::CHAT_HEADER_H))
        .flex_shrink_0()
        .pl(px(Layout::CHAT_PAD_X))
        .pr(px(18.5))
        .items_center()
        .bg(rgb(0xfdfcfb))
        .child(
            div()
                .min_w_0()
                .text_size(px(14.))
                .font_medium()
                .text_color(calm.foreground)
                .whitespace_nowrap()
                .overflow_hidden()
                .text_ellipsis()
                .child(title.to_string()),
        )
        .child(
            h_flex()
                .ml(px(9.5))
                .gap(px(4.))
                .items_center()
                .child(action("refresh-cw"))
                .child(action("share-2"))
                .child(action("download"))
                .child(action("bookmark-plus"))
                .child(action("life-buoy")),
        )
        .child(div().flex_1())
        .child(action("users"))
}

/// Consecutive agent prose blocks are separated by a hairline rule, the way
/// Desktop splits one turn's text parts.
fn render_thread(calm: &Calm, messages: &[MessageRow], code_w: f32) -> Vec<AnyElement> {
    let mut out = Vec::new();
    let mut prev_agent = false;
    for (i, m) in messages.iter().enumerate() {
        match &m.kind {
            BubbleKind::Agent => {
                if prev_agent {
                    out.push(
                        div()
                            .w_full()
                            .h(px(1.))
                            .my(px(20.))
                            .bg(hsla(0.1, 0.05, 0.1, 0.1))
                            .into_any_element(),
                    );
                }
                out.push(render_agent_text(calm, i, m, code_w).into_any_element());
                prev_agent = true;
            }
            BubbleKind::User => {
                out.push(render_user(calm, m).into_any_element());
                prev_agent = false;
            }
            BubbleKind::Other(k) => {
                out.push(
                    div()
                        .text_size(Type::preview())
                        .text_color(calm.faint)
                        .child(format!("{k} · {}", m.body))
                        .into_any_element(),
                );
                prev_agent = false;
            }
        }
    }
    out
}

fn render_agent_text(calm: &Calm, i: usize, m: &MessageRow, code_w: f32) -> impl IntoElement {
    v_flex()
        .w_full()
        .gap(px(6.))
        .when(!m.tools.is_empty(), |col| {
            col.children(m.tools.iter().map(|t| render_tool_row(calm, t, 0.)))
        })
        .when(!m.body.trim().is_empty(), |col| {
            let muted = calm.muted;
            col.child(
                div()
                    .w_full()
                    .text_size(Type::body())
                    .line_height(px(20.))
                    .text_color(calm.foreground)
                    .child(
                        TextView::markdown(
                            SharedString::from(format!("md-{i}-{}", m.created_at)),
                            m.body.clone(),
                        )
                        .style(chat_md_style(calm))
                        .code_block_actions(move |block, _, _| {
                            code_block_header(block, code_w, muted)
                        }),
                    ),
            )
        })
}

/// Desktop `.chat-md` + the `message.tsx` element overrides, at 13.5px body.
/// Base TextView leaves `paragraph_gap` below every block and adds a
/// heading's own top/bottom padding, so CSS margin collapsing is reproduced
/// as `max(heading margin, p margin) - paragraph_gap` above and
/// `max(heading margin, p margin)` below.
fn chat_md_style(calm: &Calm) -> TextViewStyle {
    const BODY: f32 = 13.5;
    const P_MARGIN: f32 = BODY * 0.4;
    // (font-size em, line-height, margin-top em, margin-bottom em)
    let heading = |level: u8| match level {
        1 => (1.5, 1.25, 1.15, 0.3),
        2 => (1.25, 1.3, 1.1, 0.25),
        3 => (1.1, 1.35, 1.0, 0.2),
        _ => (1.0, 1.5, 0.9, 0.2),
    };
    let mut code_block = StyleRefinement::default()
        .bg(rgb(0xf7f6f3))
        .text_color(rgb(0x37352f))
        .border_0()
        .rounded(px(8.))
        .px(px(16.))
        .pt(px(26.))
        .pb(px(14.))
        .text_size(px(BODY))
        .line_height(relative(1.5))
        .my(px(10. - P_MARGIN));
    code_block.text.font_family = Some(FONT_MONO.into());
    TextViewStyle::default()
        .with_foreground(calm.foreground)
        .with_muted_foreground(calm.muted)
        .with_link(calm.foreground)
        .with_border(hsla(0.17, 0.12, 0.09, 0.09))
        .with_code_background(rgb(0xf7f6f3).into())
        .with_paragraph_gap(rems(P_MARGIN / 16.))
        .with_heading(move |level| {
            let (size_em, line_h, mt_em, mb_em) = heading(level);
            let size = BODY * size_em;
            StyleRefinement::default()
                .text_size(px(size))
                .line_height(relative(line_h))
                .pt(px((size * mt_em).max(P_MARGIN) - P_MARGIN))
                .pb(px((size * mb_em).max(P_MARGIN)))
        })
        .with_code_block(code_block)
        .with_inline_code(HighlightStyle::default())
        .with_inline_code_style(
            StyleRefinement::default()
                .bg(calm.nav_bg)
                .border_1()
                .border_color(rgb(0xe2e0db))
                .rounded(px(4.))
                .px(px(4.))
                .text_color(rgb(0x35352e)),
        )
}

/// Desktop `CodeBlock` header (`px-3 pt-1.5`): mono language label on the
/// left, copy icon on the right. Base pins the actions slot at top-2/right-2,
/// so the row is sized to span the block from there.
fn code_block_header(block: &CodeBlock, code_w: f32, muted: Hsla) -> impl IntoElement {
    let lang = block.lang().filter(|l| !l.is_empty()).unwrap_or_else(|| "text".into());
    h_flex()
        .w(px((code_w - 20.).max(40.)))
        .h(px(16.))
        .mt(px(-2.))
        .pr(px(4.))
        .justify_between()
        .items_center()
        .child(div().font_family(FONT_MONO).text_size(px(12.)).text_color(muted).child(lang))
        .child(icon("copy", 14., muted))
}

fn render_user(calm: &Calm, m: &MessageRow) -> impl IntoElement {
    let clock = message_clock(&m.created_at);
    v_flex()
        .w_full()
        .mt(px(40.5))
        .items_end()
        .gap(px(6.))
        .child(
            div()
                .pr(px(4.))
                .font_family(FONT_MONO)
                .text_size(Type::mono())
                .text_color(calm.muted)
                .child(format!("{clock} 你")),
        )
        .child(
            v_flex()
                .max_w(relative(0.85))
                .rounded(px(Layout::BUBBLE_RADIUS))
                .rounded_br(px(Layout::BUBBLE_SPEAKER))
                .bg(calm.user_bubble)
                .overflow_hidden()
                .when_some(m.mention.clone(), |col, name| {
                    col.child(
                        h_flex()
                            .w_full()
                            .h(px(37.))
                            .pt(px(5.))
                            .px(px(16.))
                            .gap(px(7.5))
                            .items_center()
                            .border_b_1()
                            .border_color(calm.user_bubble_rule)
                            .child(
                                div()
                                    .font_family(FONT_MONO)
                                    .text_size(px(9.5))
                                    .font_semibold()
                                    .text_color(calm.coral)
                                    .child("AGENT"),
                            )
                            .child(
                                div()
                                    .text_size(Type::card_title())
                                    .font_semibold()
                                    .text_color(calm.foreground)
                                    .child(format!("@{name}")),
                            ),
                    )
                })
                .child(
                    div()
                        .px(px(16.))
                        .pt(px(8.))
                        .pb(px(12.))
                        .text_size(Type::body())
                        .line_height(px(20.))
                        .text_color(calm.foreground)
                        .child(m.body.clone()),
                ),
        )
}

fn render_composer_stack<T: 'static>(
    calm: &Calm,
    props: &ChatProps<'_>,
    cx: &mut Context<T>,
    on_toggle_live: impl Fn(&mut T, &mut Context<T>) + 'static,
) -> impl IntoElement {
    div().w_full().px(px(Layout::CHAT_PAD_X)).pb(px(25.)).child(
        v_flex()
            .w_full()
            .rounded(px(Layout::COMPOSER_RADIUS))
            .bg(calm.paper)
            .border_1()
            .border_color(hsla(0.0, 0.0, 0.0, 0.07))
            .shadow(vec![BoxShadow {
                color: hsla(0.1, 0.05, 0.1, 0.1),
                offset: point(px(0.), px(4.)),
                blur_radius: px(16.),
                spread_radius: px(-10.),
                inset: false,
            }])
            .overflow_hidden()
            .when_some(props.live, |col, live| {
                col.child(render_live_header(calm, live, props.live_open, cx, on_toggle_live))
                    .when(props.live_open, |col| col.child(render_live_body(calm, live)))
                    .child(div().w_full().h(px(1.)).bg(hsla(0.0, 0.0, 0.0, 0.07)))
            })
            .child(
                div()
                    .w_full()
                    .px(px(14.))
                    .pt(px(12.))
                    .min_h(px(60.))
                    .text_size(px(14.))
                    .child(Input::new(props.composer).appearance(false)),
            )
            .child(render_composer_toolbar(calm, props.agent_name)),
    )
}

fn agent_avatar(calm: &Calm, name: &str, color: u32) -> impl IntoElement {
    h_flex()
        .size(px(24.))
        .rounded(px(7.))
        .border(px(1.5))
        .border_color(calm.coral)
        .items_center()
        .justify_center()
        .child(
            h_flex()
                .size(px(20.))
                .rounded(px(5.))
                .bg(rgb(color))
                .items_center()
                .justify_center()
                .child(
                    div()
                        .text_size(px(10.))
                        .font_semibold()
                        .text_color(rgb(0xffffff))
                        .child(actor_letter(name)),
                ),
        )
}

fn render_live_header<T: 'static>(
    calm: &Calm,
    live: &LiveTurn,
    open: bool,
    cx: &mut Context<T>,
    on_toggle: impl Fn(&mut T, &mut Context<T>) + 'static,
) -> impl IntoElement {
    h_flex()
        .w_full()
        .h(px(50.))
        .pl(px(14.))
        .pr(px(14.))
        .gap(px(10.))
        .items_center()
        .child(
            h_flex()
                .id("live-toggle")
                .flex_1()
                .min_w_0()
                .gap(px(8.5))
                .items_center()
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, _, cx| on_toggle(this, cx)))
                .child(icon(if open { "chevron-up" } else { "chevron-down" }, 14., calm.coral))
                .child(agent_avatar(calm, &live.agent_name, live.agent_color))
                .child(
                    div()
                        .text_size(Type::secondary())
                        .font_semibold()
                        .text_color(calm.foreground)
                        .child(live.agent_name.clone()),
                )
                .child(
                    h_flex()
                        .items_center()
                        .gap(px(6.))
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(calm.muted)
                                .child("正在回复"),
                        )
                        .child(div().size(px(5.)).rounded_full().bg(calm.coral)),
                ),
        )
        .child(
            div()
                .size(px(28.))
                .mr(px(-6.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon("maximize-2", 14., calm.muted)),
        )
        .child(
            div()
                .size(px(28.))
                .rounded_lg()
                .bg(hsla(0.016, 0.77, 0.6, 0.15))
                .flex()
                .items_center()
                .justify_center()
                .child(div().size(px(10.)).rounded(px(2.)).bg(calm.coral)),
        )
}

fn render_live_body(calm: &Calm, live: &LiveTurn) -> impl IntoElement {
    v_flex()
        .w_full()
        .bg(calm.turn_body_bg)
        .border_t_1()
        .border_color(hsla(0.0, 0.0, 0.0, 0.04))
        .px(px(14.))
        .pt(px(14.))
        .pb(px(12.))
        .gap(px(4.5))
        .children(live.steps.iter().map(|step| match step {
            LiveStep::Tool(t) => render_tool_row(calm, t, 8.).into_any_element(),
            LiveStep::Thinking => h_flex()
                .h(px(29.))
                .pt(px(4.))
                .gap(px(6.))
                .items_center()
                .child(icon("brain", 15., calm.muted))
                .child(
                    div()
                        .text_size(Type::secondary())
                        .text_color(calm.ink_2)
                        .child("思考过程"),
                )
                .child(icon("chevron-down", 13., calm.muted))
                .into_any_element(),
        }))
        .child(
            h_flex()
                .h(px(22.))
                .mt(px(3.5))
                .gap(px(3.))
                .items_center()
                .child(div().size(px(6.)).rounded_full().bg(rgb(0x8e8c86)))
                .child(div().size(px(6.)).rounded_full().bg(rgb(0xa8a6a0)))
                .child(div().size(px(6.)).rounded_full().bg(rgb(0xd4d2cd))),
        )
}

/// Desktop ToolCallDisclosure compact row: `>_ Bash · args … 22.7s ✓`.
fn render_tool_row(calm: &Calm, t: &ToolCallRow, indent: f32) -> impl IntoElement {
    h_flex()
        .w_full()
        .h(px(29.))
        .pl(px(indent + 1.5))
        .items_center()
        .child(icon("terminal", 14., calm.muted))
        .child(
            div()
                .ml(px(10.))
                .text_size(Type::card_title())
                .font_semibold()
                .text_color(calm.foreground)
                .flex_shrink_0()
                .child(t.name.clone()),
        )
        .child(
            div()
                .mx(px(7.))
                .text_size(Type::preview())
                .text_color(calm.faint)
                .child("·"),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .font_family(FONT_MONO)
                .text_size(px(11.5))
                .text_color(calm.muted)
                .whitespace_nowrap()
                .overflow_hidden()
                .text_ellipsis()
                .child(t.args_summary.clone()),
        )
        .child(
            h_flex()
                .pl(px(8.))
                .pr(px(7.))
                .gap(px(4.))
                .items_center()
                .flex_shrink_0()
                .when_some(t.duration_label.clone(), |row, d| {
                    row.child(
                        div()
                            .font_family(FONT_MONO)
                            .text_size(px(11.))
                            .text_color(calm.faint)
                            .child(d),
                    )
                })
                .map(|row| match t.status {
                    ToolStatus::Ok => row.child(icon("check", 12., calm.tool_ok)),
                    ToolStatus::Error => row.child(icon("x", 13., calm.tool_error)),
                    ToolStatus::Pending => row.child(
                        div()
                            .size(px(22.))
                            .mr(px(6.))
                            .rounded_full()
                            .bg(hsla(0.42, 0.6, 0.45, 0.1))
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(div().size(px(9.)).rounded_full().bg(calm.online)),
                    ),
                }),
        )
}

fn render_composer_toolbar(calm: &Calm, agent: &str) -> impl IntoElement {
    let plain = |name: &'static str, size: f32| {
        div()
            .size(px(28.))
            .rounded_md()
            .flex()
            .items_center()
            .justify_center()
            .hover(|s| s.bg(hsla(0.0, 0.0, 0.0, 0.04)))
            .child(icon(name, size, calm.ink_2))
    };
    h_flex()
        .w_full()
        .h(px(48.))
        .pl(px(10.))
        .pr(px(10.))
        .items_center()
        .gap(px(4.))
        .child(plain("plus", 16.))
        .child(div())
        .child(plain("mic", 17.))
        .child(icon("chevron-down", 15., calm.muted))
        .child(div().w(px(9.)))
        .child(
            h_flex()
                .items_center()
                .gap(px(2.))
                .child(icon("info", 16., calm.ink_2))
                .child(
                    div()
                        .text_size(Type::secondary())
                        .text_color(calm.ink_2)
                        .child("完全访问权限"),
                )
                .child(div().w(px(1.)))
                .child(icon("chevron-down", 15., calm.faint)),
        )
        .child(div().w(px(6.)))
        .child(
            h_flex()
                .h(px(30.))
                .px(px(10.5))
                .gap(px(4.))
                .items_center()
                .rounded(px(15.))
                .bg(rgb(0xf4f3ef))
                .child(div().size(px(7.)).rounded_full().bg(calm.online))
                .child(
                    div()
                        .text_size(Type::secondary())
                        .font_semibold()
                        .text_color(calm.foreground)
                        .child(agent.to_string()),
                )
                .child(div().text_size(Type::preview()).text_color(calm.faint).child("·"))
                .child(
                    div()
                        .font_family(FONT_MONO)
                        .text_size(px(11.))
                        .text_color(calm.ink_2)
                        .child("pro"),
                )
                .child(icon("chevron-down", 15., calm.ink_2)),
        )
        .child(
            div()
                .ml(px(3.))
                .flex_1()
                .min_w_0()
                .text_size(Type::preview())
                .text_color(calm.faint)
                .whitespace_nowrap()
                .overflow_hidden()
                .text_ellipsis()
                .child(format!("后续消息会自动提及{agent}")),
        )
        .child(
            div()
                .size(px(32.))
                .rounded(px(9.))
                .bg(calm.coral_soft)
                .flex()
                .items_center()
                .justify_center()
                .child(icon("send", 16., rgb(0xffffff).into())),
        )
}
