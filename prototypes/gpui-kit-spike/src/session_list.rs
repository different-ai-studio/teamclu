//! SessionListColumn 1:1 — kind dropdown header, flat rows, one shared
//! selection pill (Desktop SessionLiquidGlass).

use crate::cloud::{ParticipantChip, SessionRow};
use crate::demo::{
    estimate_row_height, format_relative_list_time, show_participants, show_preview,
    split_preview_mentions,
};
use crate::theme::{actor_disc_color, actor_letter, icon, Calm, Layout, Type, FONT_SANS};
use gpui_kit::component::h_flex;
use gpui_kit::component::scroll::ScrollableElement;
use gpui_kit::component::v_flex;
use gpui_kit::component::StyledExt;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

pub struct SessionListProps<'a> {
    pub sessions: &'a [SessionRow],
    pub selected: usize,
    pub glass_moving: bool,
    pub actions_open: Option<usize>,
}

/// Shared pill top offset inside the scroll content (spike: no DOM measure).
fn glass_offset_y(sessions: &[SessionRow], selected: usize) -> f32 {
    sessions
        .iter()
        .take(selected)
        .map(|s| estimate_row_height(s) + Layout::ROW_GAP)
        .sum::<f32>()
        + Layout::ROW_GAP / 2.
}

pub fn render_session_column<T: 'static>(
    calm: &Calm,
    props: SessionListProps<'_>,
    cx: &mut Context<T>,
    on_select: impl Fn(&mut T, usize, &mut Context<T>) + 'static + Clone,
    on_toggle_actions: impl Fn(&mut T, usize, &mut Context<T>) + 'static + Clone,
    on_action: impl Fn(&mut T, usize, &str, &mut Context<T>) + 'static + Clone,
) -> impl IntoElement {
    let glass_y = glass_offset_y(props.sessions, props.selected);
    let glass_h = props
        .sessions
        .get(props.selected)
        .map(estimate_row_height)
        .unwrap_or(Layout::ROW_H);
    let radius = if props.glass_moving {
        Layout::GLASS_RADIUS_MOVING
    } else {
        Layout::GLASS_RADIUS
    };
    let any_unread = props.sessions.iter().any(|s| s.has_unread) || !props.sessions.is_empty();

    v_flex()
        .id("session-list")
        .w(px(Layout::SESSION_W))
        .h_full()
        .flex_shrink_0()
        .bg(calm.list_bg)
        .border_r_1()
        .border_color(hsla(0.0, 0.0, 0.0, 0.06))
        .font_family(FONT_SANS)
        .child(render_header(calm, any_unread))
        .child(
            div()
                .id("session-scroll")
                .relative()
                .flex_1()
                .min_h_0()
                .px(px(Layout::SESSION_PAD_X))
                .pt(px(Layout::SESSION_PAD_TOP))
                .pb_2()
                .overflow_y_scrollbar()
                .when(!props.sessions.is_empty(), |d| {
                    d.child(
                        div()
                            .id("session-liquid-glass")
                            .absolute()
                            .left(px(Layout::SESSION_PAD_X))
                            .right(px(Layout::SESSION_PAD_X + 1.))
                            .top(px(Layout::SESSION_PAD_TOP + glass_y))
                            .h(px(glass_h))
                            .rounded(px(radius))
                            .bg(rgb(0xfdfdfb))
                            .border_1()
                            .border_color(hsla(0.1, 0.05, 0.1, 0.07))
                            .shadow(vec![
                                BoxShadow {
                                    color: hsla(0.1, 0.05, 0.1, 0.06),
                                    offset: point(px(0.), px(2.)),
                                    blur_radius: px(8.),
                                    spread_radius: px(0.),
                                    inset: false,
                                },
                                BoxShadow {
                                    color: hsla(0.1, 0.05, 0.1, 0.04),
                                    offset: point(px(0.), px(1.)),
                                    blur_radius: px(2.),
                                    spread_radius: px(0.),
                                    inset: false,
                                },
                            ]),
                    )
                })
                .child(v_flex().w_full().children(props.sessions.iter().enumerate().map(
                    |(i, s)| {
                        session_card(
                            calm,
                            s,
                            i == props.selected,
                            props.actions_open == Some(i),
                            i,
                            cx,
                            on_select.clone(),
                            on_toggle_actions.clone(),
                            on_action.clone(),
                        )
                    },
                ))),
        )
}

fn render_header(calm: &Calm, badge: bool) -> impl IntoElement {
    let icon_btn = |name: &'static str| {
        div()
            .size(px(28.))
            .rounded_md()
            .flex()
            .items_center()
            .justify_center()
            .hover(|s| s.bg(hsla(0.0, 0.0, 0.0, 0.04)))
            .child(icon(name, 16., calm.muted))
    };
    h_flex()
        .w_full()
        .h(px(Layout::SESSION_HEADER_H))
        .flex_shrink_0()
        .pt(px(3.))
        .pl(px(8.))
        .pr(px(8.))
        .items_center()
        .justify_between()
        .child(
            h_flex()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .relative()
                        .size(px(24.))
                        .rounded_md()
                        .bg(calm.nav_bg)
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon("message-square", 14., calm.ink_2))
                        .when(badge, |d| {
                            d.child(
                                div()
                                    .absolute()
                                    .top(px(-2.))
                                    .right(px(-2.))
                                    .size(px(7.))
                                    .rounded_full()
                                    .bg(calm.coral),
                            )
                        }),
                )
                .child(
                    div()
                        .text_size(px(14.))
                        .font_bold()
                        .text_color(calm.foreground)
                        .child("聊天"),
                )
                .child(icon("chevron-down", 14., calm.muted)),
        )
        .child(
            h_flex()
                .items_center()
                .gap(px(2.))
                .child(icon_btn("search"))
                .child(icon_btn("list-checks")),
        )
}

/// One text run so `text_ellipsis` truncates the whole line; `@mentions`
/// keep Desktop's coral `<em>` styling as highlights.
fn preview_text(calm: &Calm, parts: Vec<(bool, String)>) -> StyledText {
    let mut text = String::new();
    let mut highlights = Vec::new();
    for (is_mention, part) in parts {
        let start = text.len();
        text.push_str(&part);
        if is_mention {
            highlights.push((
                start..text.len(),
                HighlightStyle {
                    color: Some(calm.coral),
                    font_weight: Some(FontWeight::MEDIUM),
                    ..Default::default()
                },
            ));
        }
    }
    StyledText::new(text).with_highlights(highlights)
}

#[allow(clippy::too_many_arguments)]
fn session_card<T: 'static>(
    calm: &Calm,
    s: &SessionRow,
    active: bool,
    actions_open: bool,
    index: usize,
    cx: &mut Context<T>,
    on_select: impl Fn(&mut T, usize, &mut Context<T>) + 'static,
    on_toggle_actions: impl Fn(&mut T, usize, &mut Context<T>) + 'static,
    on_action: impl Fn(&mut T, usize, &str, &mut Context<T>) + 'static + Clone,
) -> impl IntoElement {
    // Desktop renders the preview as HTML text, so newline runs collapse to
    // one space; a raw "\n" here would wrap the StyledText onto a hidden line.
    let flat_preview = s.preview.split_whitespace().collect::<Vec<_>>().join(" ");
    let preview_parts = split_preview_mentions(&flat_preview);
    let clock = format_relative_list_time(&s.last_message_at);
    let has_unread = s.has_unread && !active;
    let participant_count = s.participant_count.max(s.participants.len());
    let chips: Vec<ParticipantChip> = s.participants.iter().take(3).cloned().collect();
    let with_parts = show_participants(s);
    let more_id = SharedString::from(format!("more-{index}"));

    v_flex()
        .id(SharedString::from(format!("sess-{index}")))
        .group(SharedString::from(format!("row-{index}")))
        .relative()
        .w_full()
        .h(px(estimate_row_height(s)))
        .my(px(Layout::ROW_GAP / 2.))
        .rounded(px(Layout::GLASS_RADIUS))
        .px(px(9.))
        .pt(px(5.))
        .gap(px(2.))
        .cursor_pointer()
        .when(!active, |d| d.hover(|s| s.bg(hsla(0.0, 0.0, 0.0, 0.035))))
        .on_click(cx.listener(move |this, _, _, cx| on_select(this, index, cx)))
        .child(
            h_flex()
                .w_full()
                .h(px(22.))
                .items_center()
                .gap(px(6.))
                .when(s.is_pinned, |row| row.child(icon("pin", 12., rgb(0xf59e0b).into())))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(Type::card_title())
                        .font_semibold()
                        .text_color(calm.foreground)
                        .whitespace_nowrap()
                        .overflow_hidden()
                        .text_ellipsis()
                        .child(s.title.clone()),
                )
                .when(has_unread, |row| {
                    row.child(div().size(px(6.)).rounded_full().bg(calm.coral).flex_shrink_0())
                })
                .child(
                    div()
                        .px(px(2.))
                        .text_size(Type::mono())
                        .text_color(calm.faint)
                        .flex_shrink_0()
                        .child(clock),
                )
                .child(
                    div()
                        .id(more_id)
                        .h(px(22.))
                        .rounded_md()
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .when(!actions_open, |d| {
                            d.w(px(0.))
                                .overflow_hidden()
                                .group_hover(SharedString::from(format!("row-{index}")), |s| {
                                    s.w(px(22.))
                                })
                        })
                        .when(actions_open, |d| d.w(px(22.)).bg(hsla(0.0, 0.0, 0.0, 0.08)))
                        .hover(|s| s.bg(hsla(0.0, 0.0, 0.0, 0.08)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            on_toggle_actions(this, index, cx);
                        }))
                        .child(icon(if actions_open { "x" } else { "ellipsis" }, 12., calm.muted)),
                ),
        )
        .when_some(s.app_label.clone(), |col, label| {
            col.child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap_1()
                    .child(icon("app-window", 12., calm.faint))
                    .child(
                        div()
                            .min_w_0()
                            .text_size(px(11.))
                            .text_color(calm.faint)
                            .whitespace_nowrap()
                            .overflow_hidden()
                            .text_ellipsis()
                            .child(label),
                    ),
            )
        })
        .when(show_preview(s), |col| {
            col.child(
                div()
                    .w_full()
                    .min_w_0()
                    .text_size(Type::preview())
                    .text_color(calm.muted)
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_ellipsis()
                    .opacity(if actions_open { 0.5 } else { 1.0 })
                    .child(preview_text(calm, preview_parts)),
            )
        })
        .when(with_parts, |col| {
            col.child(
                h_flex()
                    .w_full()
                    .h(px(16.))
                    .mt(px(-0.5))
                    .items_center()
                    .gap(px(6.))
                    .child(h_flex().children(chips.into_iter().enumerate().map(|(i, p)| {
                        h_flex()
                            .when(i > 0, |d| d.ml(px(-6.)))
                            .size(px(16.))
                            .when(p.is_agent, |d| d.rounded(px(3.)))
                            .when(!p.is_agent, |d| d.rounded_full())
                            .bg(rgb(p.color.unwrap_or_else(|| actor_disc_color(&p.name))))
                            .border_1()
                            .border_color(calm.paper)
                            .items_center()
                            .justify_center()
                            .child(
                                div()
                                    .text_size(px(8.))
                                    .font_semibold()
                                    .text_color(rgb(0xffffff))
                                    .child(actor_letter(&p.name)),
                            )
                    })))
                    .child(
                        div()
                            .text_size(px(10.5))
                            .text_color(calm.faint)
                            .child(format!("{participant_count} 位")),
                    ),
            )
        })
        .when(actions_open, |col| {
            col.child(
                h_flex().w_full().gap_1().pt_1().children(
                    [("pin", "pin"), ("pencil", "rename"), ("info", "info"), ("archive", "archive")]
                        .into_iter()
                        .map(|(glyph, key)| {
                            let on_action = on_action.clone();
                            div()
                                .id(SharedString::from(format!("act-{index}-{key}")))
                                .flex_1()
                                .h(px(26.))
                                .rounded_md()
                                .flex()
                                .items_center()
                                .justify_center()
                                .bg(hsla(0.0, 0.0, 0.0, 0.04))
                                .hover(|s| s.bg(hsla(0.0, 0.0, 0.0, 0.08)))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    on_action(this, index, key, cx);
                                }))
                                .child(icon(glyph, 14., calm.ink_2))
                        }),
                ),
            )
        })
}
