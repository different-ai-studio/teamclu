//! NavRail 1:1 vs Desktop NavRail + NewChatSplitButton + LocalDaemonCard.

use crate::theme::{icon, Calm, Layout, Type, FONT_MONO, FONT_SANS};
use gpui_kit::component::h_flex;
use gpui_kit::component::v_flex;
use gpui_kit::component::StyledExt;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

pub struct NavProps {
    pub more_open: bool,
    pub filter: &'static str,
    pub has_unread: bool,
}

#[derive(Clone, Copy)]
enum Trailing {
    None,
    UnreadRing,
    Plus,
}

pub fn render_nav<T: 'static>(
    calm: &Calm,
    props: NavProps,
    cx: &mut Context<T>,
    on_toggle_more: impl Fn(&mut T, &mut Context<T>) + 'static + Clone,
    on_new_chat: impl Fn(&mut T, &mut Context<T>) + 'static + Clone,
    on_advanced: impl Fn(&mut T, &mut Context<T>) + 'static + Clone,
    on_filter: impl Fn(&mut T, &str, &mut Context<T>) + 'static + Clone,
) -> impl IntoElement {
    let entry = |icon_name: &'static str, label: &'static str, key: &'static str, trailing, cx: &mut Context<T>| {
        let on_filter = on_filter.clone();
        nav_entry(calm, icon_name, label, props.filter == key, trailing, cx, move |this, cx| {
            on_filter(this, key, cx)
        })
    };
    let sessions_trailing = if props.has_unread {
        Trailing::UnreadRing
    } else {
        Trailing::None
    };

    v_flex()
        .id("nav-rail")
        .w(px(Layout::NAV_W))
        .h_full()
        .flex_shrink_0()
        .bg(calm.nav_bg)
        .border_r_1()
        .border_color(hsla(0.0, 0.0, 0.0, 0.04))
        .font_family(FONT_SANS)
        .px(px(Layout::NAV_PAD_X))
        .pb(px(13.))
        // Native traffic lights sit over this strip (TitlebarOptions).
        .child(
            h_flex()
                .w_full()
                .h(px(Layout::NAV_TOP_STRIP_H))
                .flex_shrink_0()
                .items_center()
                .justify_end()
                .pb(px(2.))
                .child(
                    div()
                        .size(px(26.))
                        .mr(px(-2.))
                        .rounded_md()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(icon("panel-left", 16., calm.muted)),
                ),
        )
        .child(render_new_chat_cta(calm, cx, on_new_chat, on_advanced))
        .child(
            v_flex()
                .mt(px(10.5))
                .gap(px(2.))
                .child(entry("inbox", "会话", "sessions", sessions_trailing, cx))
                .child(entry("users", "联系人", "contacts", Trailing::Plus, cx))
                .child(entry("sparkles", "技能", "skills", Trailing::None, cx))
                .child(entry("app-window", "应用", "apps", Trailing::None, cx)),
        )
        .child(
            h_flex()
                .id("more-toggle")
                .mt(px(10.))
                .w_full()
                .py_2()
                .items_center()
                .gap(px(10.))
                .cursor_pointer()
                .on_click(cx.listener(move |this, _, _, cx| on_toggle_more(this, cx)))
                .child(div().h(px(1.)).flex_1().bg(calm.border_soft))
                .child(
                    h_flex()
                        .items_center()
                        .gap_1()
                        .child(
                            div()
                                .text_size(px(10.))
                                .font_semibold()
                                .text_color(calm.faint)
                                .child("更多"),
                        )
                        .child(icon(
                            if props.more_open { "chevron-up" } else { "chevron-down" },
                            12.,
                            calm.faint,
                        )),
                )
                .child(div().h(px(1.)).flex_1().bg(calm.border_soft)),
        )
        .when(props.more_open, |col| {
            col.child(
                v_flex()
                    .gap(px(2.))
                    .child(entry("book-open", "知识库", "knowledge", Trailing::None, cx))
                    .child(entry("lightbulb", "想法", "ideas", Trailing::None, cx))
                    .child(entry("keyboard", "快捷方式", "shortcuts", Trailing::None, cx))
                    .child(entry("plug", "MCP", "mcp", Trailing::None, cx))
                    .child(entry("key-round", "环境变量", "env", Trailing::None, cx)),
            )
        })
        .child(div().flex_1())
        .child(render_device_card(calm))
        .child(render_footer(calm))
}

fn render_new_chat_cta<T: 'static>(
    calm: &Calm,
    cx: &mut Context<T>,
    on_primary: impl Fn(&mut T, &mut Context<T>) + 'static,
    on_advanced: impl Fn(&mut T, &mut Context<T>) + 'static,
) -> impl IntoElement {
    let hover = hsla(0.015, 0.76, 0.6, 1.0);
    h_flex()
        .id("new-chat-cta")
        .w_full()
        .h(px(Layout::CTA_H))
        .flex_shrink_0()
        .overflow_hidden()
        .rounded(px(Layout::CTA_RADIUS))
        .bg(calm.coral_cta)
        .shadow(vec![BoxShadow {
            color: hsla(0.016, 0.77, 0.6, 0.22),
            offset: point(px(0.), px(4.)),
            blur_radius: px(14.),
            spread_radius: px(0.),
            inset: false,
        }])
        .child(
            h_flex()
                .id("new-chat-primary")
                .h_full()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap_2()
                .px_3()
                .cursor_pointer()
                .hover(|s| s.bg(hover))
                .on_click(cx.listener(move |this, _, _, cx| on_primary(this, cx)))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(Type::nav())
                        .font_semibold()
                        .text_color(calm.coral_fg)
                        .child("新聊天"),
                )
                .child(
                    div()
                        .font_family(FONT_MONO)
                        .text_size(px(10.5))
                        .font_medium()
                        .text_color(hsla(0.0, 0.0, 1.0, 0.70))
                        .flex_shrink_0()
                        .child("⌘N"),
                ),
        )
        .child(
            h_flex()
                .id("new-chat-advanced")
                .h_full()
                .w(px(Layout::CTA_ADVANCED_W))
                .flex_shrink_0()
                .items_center()
                .justify_center()
                .border_l_1()
                .border_color(hsla(0.0, 0.0, 1.0, 0.15))
                .cursor_pointer()
                .hover(|s| s.bg(hover))
                .on_click(cx.listener(move |this, _, _, cx| on_advanced(this, cx)))
                .child(icon("sliders-horizontal", 14., calm.coral_fg)),
        )
}

fn nav_entry<T: 'static>(
    calm: &Calm,
    icon_name: &'static str,
    label: &'static str,
    active: bool,
    trailing: Trailing,
    cx: &mut Context<T>,
    on_click: impl Fn(&mut T, &mut Context<T>) + 'static,
) -> impl IntoElement {
    h_flex()
        .id(SharedString::from(format!("nav-{label}")))
        .w_full()
        .h(px(Layout::NAV_ENTRY_H))
        .items_center()
        .gap(px(10.))
        .rounded_lg()
        .px(px(9.))
        .cursor_pointer()
        .when(active, |d| {
            d.bg(calm.paper)
                .border_1()
                .border_color(calm.ring)
                .shadow(vec![BoxShadow {
                    color: hsla(0.1, 0.05, 0.1, 0.05),
                    offset: point(px(0.), px(1.)),
                    blur_radius: px(2.),
                    spread_radius: px(0.),
                    inset: false,
                }])
        })
        .when(!active, |d| d.hover(|s| s.bg(hsla(0.0, 0.0, 0.0, 0.04))))
        .on_click(cx.listener(move |this, _, _, cx| on_click(this, cx)))
        .child(icon(
            icon_name,
            Layout::NAV_ICON,
            if active { calm.foreground } else { calm.muted },
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(Type::nav())
                .font_weight(if active {
                    FontWeight::SEMIBOLD
                } else {
                    FontWeight::NORMAL
                })
                .text_color(if active { calm.foreground } else { calm.ink_2 })
                .child(label),
        )
        .map(|row| match trailing {
            Trailing::None => row,
            Trailing::UnreadRing => row.child(
                div()
                    .size(px(9.))
                    .mr(px(3.))
                    .rounded_full()
                    .border(px(2.))
                    .border_color(calm.coral),
            ),
            Trailing::Plus => row.child(div().mr(px(4.5)).child(icon("plus", 15., calm.muted))),
        })
}

fn render_device_card(calm: &Calm) -> impl IntoElement {
    v_flex()
        .w_full()
        .mb(px(13.5))
        .p(px(8.))
        .gap(px(8.))
        .rounded(px(12.))
        .bg(calm.paper)
        .border_1()
        .border_color(calm.border)
        .shadow(vec![BoxShadow {
            color: hsla(0.1, 0.05, 0.1, 0.04),
            offset: point(px(0.), px(1.)),
            blur_radius: px(3.),
            spread_radius: px(0.),
            inset: false,
        }])
        .child(
            h_flex()
                .w_full()
                .items_center()
                .gap(px(10.))
                .pt(px(1.))
                .child(
                    h_flex()
                        .size(px(28.))
                        .rounded(px(7.))
                        .bg(calm.coral_cta)
                        .items_center()
                        .justify_center()
                        .child(
                            div()
                                .text_size(px(11.))
                                .font_bold()
                                .text_color(calm.coral_fg)
                                .child("Pi"),
                        ),
                )
                .child(
                    div()
                        .text_size(Type::nav())
                        .font_semibold()
                        .text_color(calm.foreground)
                        .child("亮亮 Mac-mini"),
                )
                .child(
                    div()
                        .size(px(7.))
                        .rounded_full()
                        .bg(calm.online)
                        .border(px(1.5))
                        .border_color(hsla(0.42, 0.78, 0.4, 0.25)),
                ),
        )
        .child(
            h_flex()
                .w_full()
                .h(px(29.))
                .px(px(9.))
                .gap(px(9.))
                .items_center()
                .rounded(px(8.))
                .bg(calm.subtle_row)
                .child(icon("clock", 14., calm.muted))
                .child(
                    div()
                        .flex_1()
                        .text_size(Type::preview())
                        .font_medium()
                        .text_color(calm.ink_2)
                        .child("自动化"),
                )
                .child(icon("chevron-right", 14., calm.faint)),
        )
}

fn render_footer(calm: &Calm) -> impl IntoElement {
    h_flex()
        .w_full()
        .px(px(4.))
        .items_center()
        .justify_between()
        .child(
            h_flex()
                .items_center()
                .gap(px(8.))
                .child(icon("settings", 15., calm.ink_2))
                .child(
                    div()
                        .text_size(Type::nav())
                        .text_color(calm.ink_2)
                        .child("设置"),
                ),
        )
        .child(
            h_flex()
                .items_center()
                .gap(px(7.))
                .child(
                    h_flex()
                        .size(px(18.))
                        .rounded_full()
                        .bg(rgb(0x6f8a5a))
                        .items_center()
                        .justify_center()
                        .child(
                            div()
                                .text_size(px(9.))
                                .font_semibold()
                                .text_color(rgb(0xffffff))
                                .child("周"),
                        ),
                )
                .child(
                    div()
                        .text_size(Type::nav())
                        .text_color(calm.foreground)
                        .child("周金亮"),
                )
                .child(icon("chevron-up", 14., calm.ink_2)),
        )
}
