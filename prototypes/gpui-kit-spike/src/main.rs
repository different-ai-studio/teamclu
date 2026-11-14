//! Throwaway: 1:1 Editorial Calm home shell (Nav · sessions · chat) + read-only Cloud.

mod chat;
mod cloud;
mod demo;
mod nav;
mod session_list;
mod theme;

use cloud::{BubbleKind, CloudConfig, LiveTurn, MessageRow, SessionRow};
use demo::{demo_live_turn, demo_messages, demo_sessions};
use gpui_kit::component::h_flex;
use gpui_kit::component::input::InputState;
use gpui_kit::*;
use std::time::{Duration, Instant};
use theme::{Calm, Layout, FONT_SANS};

const DEMO_AGENT: &str = "研小蕉Bot";

struct SpikeApp {
    cloud: Option<CloudConfig>,
    sessions: Vec<SessionRow>,
    selected: usize,
    glass_moving: bool,
    actions_open: Option<usize>,
    messages: Vec<MessageRow>,
    live: Option<LiveTurn>,
    live_open: bool,
    status: SharedString,
    loading: bool,
    more_open: bool,
    filter: &'static str,
    rss_mb: Option<f64>,
    last_rss_at: Instant,
    composer: Entity<InputState>,
    thread_scroll: ScrollHandle,
    _load_task: Task<()>,
    _glass_task: Task<()>,
}

impl SpikeApp {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let cloud = CloudConfig::from_env().ok();
        // Desktop `ChatInputArea`: "继续输入..." only while a turn streams.
        let placeholder = if cloud.is_some() {
            "输入 @ 提及人或 agent，# 引用文件..."
        } else {
            "继续输入..."
        };
        let composer = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        let sessions = demo_sessions();
        let messages = demo_messages("demo-1");
        let mut app = Self {
            cloud,
            sessions,
            selected: 0,
            glass_moving: false,
            actions_open: None,
            live: demo_live_turn("demo-1"),
            live_open: true,
            messages,
            status: "demo · set TEAMCLU_ACCESS_TOKEN + TEAMCLU_TEAM_ID".into(),
            loading: false,
            more_open: false,
            filter: "sessions",
            rss_mb: process_rss_mb(),
            last_rss_at: Instant::now(),
            composer,
            thread_scroll: ScrollHandle::new(),
            _load_task: Task::ready(()),
            _glass_task: Task::ready(()),
        };
        if app.cloud.is_some() {
            app.live = None;
            app.status = "live · loading…".into();
            app.reload_sessions(cx);
        }
        app
    }

    fn reload_sessions(&mut self, cx: &mut Context<Self>) {
        let Some(cfg) = self.cloud.clone() else {
            self.sessions = demo_sessions();
            self.selected = 0;
            self.messages = demo_messages("demo-1");
            self.live = demo_live_turn("demo-1");
            self.status = "demo".into();
            cx.notify();
            return;
        };
        self.loading = true;
        self.status = "live · loading sessions…".into();
        cx.notify();
        self._load_task = cx.spawn(async move |this, cx| {
            let result = cx
                .background_spawn(async move { cloud::list_sessions(&cfg, 50) })
                .await;
            this.update(cx, |app, cx| {
                app.loading = false;
                match result {
                    Ok(rows) if rows.is_empty() => {
                        app.sessions.clear();
                        app.messages.clear();
                        app.status = "live · 0 sessions".into();
                    }
                    Ok(rows) => {
                        let n = rows.len();
                        app.sessions = rows;
                        app.selected = 0;
                        app.status = format!(
                            "live · {n} · {}",
                            app.cloud.as_ref().unwrap().base_url
                        )
                        .into();
                        app.load_messages(cx);
                    }
                    Err(e) => app.status = format!("live error · {e}").into(),
                }
                cx.notify();
            })
            .ok();
        });
    }

    fn select(&mut self, index: usize, cx: &mut Context<Self>) {
        if index >= self.sessions.len() {
            return;
        }
        let moved = self.selected != index;
        self.selected = index;
        self.actions_open = None;
        if moved {
            self.glass_moving = true;
            self._glass_task = cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(420))
                    .await;
                this.update(cx, |app, cx| {
                    app.glass_moving = false;
                    cx.notify();
                })
                .ok();
            });
        }
        if self.cloud.is_some() {
            self.load_messages(cx);
        } else {
            let id = self.sessions[index].id.clone();
            self.messages = demo_messages(&id);
            self.live = demo_live_turn(&id);
            cx.notify();
        }
    }

    fn load_messages(&mut self, cx: &mut Context<Self>) {
        let Some(cfg) = self.cloud.clone() else {
            return;
        };
        let Some(session) = self.sessions.get(self.selected).cloned() else {
            return;
        };
        self.loading = true;
        cx.notify();
        self._load_task = cx.spawn(async move |this, cx| {
            let sid = session.id.clone();
            let result = cx
                .background_spawn(async move { cloud::list_messages(&cfg, &sid, 40) })
                .await;
            this.update(cx, |app, cx| {
                app.loading = false;
                match result {
                    Ok(msgs) => {
                        // Desktop MessageList virtualizer: `anchorTo: "end"`.
                        app.thread_scroll.scroll_to_bottom();
                        app.messages = msgs;
                    }
                    Err(e) => {
                        app.messages = vec![MessageRow {
                            kind: BubbleKind::Other("error".into()),
                            body: format!("加载失败：{e}"),
                            created_at: String::new(),
                            actor_name: "error".into(),
                            model: None,
                            tools: Vec::new(),
                            mention: None,
                        }];
                    }
                }
                cx.notify();
            })
            .ok();
        });
    }
}

impl Render for SpikeApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let thread_w = f32::from(window.viewport_size().width) - Layout::NAV_W - Layout::SESSION_W;
        if self.last_rss_at.elapsed() > Duration::from_secs(2) {
            self.rss_mb = process_rss_mb();
            self.last_rss_at = Instant::now();
        }
        let calm = Calm::light();
        let sessions = self.sessions.clone();
        let selected = self.selected;
        let title = sessions
            .get(selected)
            .map(|s| s.title.clone())
            .unwrap_or_else(|| "聊天".into());
        let has_unread = sessions.iter().any(|s| s.has_unread) || self.live.is_some();

        h_flex()
            .id("home")
            .size_full()
            .bg(calm.chat_bg)
            .text_color(calm.foreground)
            .font_family(FONT_SANS)
            .child(nav::render_nav(
                &calm,
                nav::NavProps {
                    more_open: self.more_open,
                    filter: self.filter,
                    has_unread,
                },
                cx,
                |this, cx| {
                    this.more_open = !this.more_open;
                    cx.notify();
                },
                |this, cx| {
                    this.status = "spike · 新聊天 stub（只读）".into();
                    cx.notify();
                },
                |this, cx| {
                    this.status = "spike · 高级会话 stub".into();
                    cx.notify();
                },
                |this, f, cx| {
                    this.filter = match f {
                        "contacts" => "contacts",
                        "skills" => "skills",
                        "apps" => "apps",
                        "ideas" => "ideas",
                        "shortcuts" => "shortcuts",
                        "knowledge" => "knowledge",
                        "mcp" => "mcp",
                        "env" => "env",
                        _ => "sessions",
                    };
                    cx.notify();
                },
            ))
            .child(session_list::render_session_column(
                &calm,
                session_list::SessionListProps {
                    sessions: &sessions,
                    selected,
                    glass_moving: self.glass_moving,
                    actions_open: self.actions_open,
                },
                cx,
                |this, i, cx| this.select(i, cx),
                |this, i, cx| {
                    this.actions_open = if this.actions_open == Some(i) {
                        None
                    } else {
                        Some(i)
                    };
                    cx.notify();
                },
                |this, _i, key, cx| {
                    this.status = format!("spike · 会话动作 stub · {key}").into();
                    this.actions_open = None;
                    cx.notify();
                },
            ))
            .child(chat::render_chat(
                &calm,
                chat::ChatProps {
                    title: &title,
                    messages: &self.messages,
                    live: self.live.as_ref(),
                    live_open: self.live_open,
                    agent_name: DEMO_AGENT,
                    composer: &self.composer,
                    thread_scroll: &self.thread_scroll,
                    thread_w,
                },
                cx,
                |this, cx| {
                    this.live_open = !this.live_open;
                    cx.notify();
                },
            ))
    }
}

fn process_rss_mb() -> Option<f64> {
    let pid = std::process::id();
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let kb: f64 = String::from_utf8_lossy(&output.stdout).trim().parse().ok()?;
    Some(kb / 1024.0)
}

fn main() {
    gpui_kit::application()
        .with_assets(gpui_kit::assets::AllAssets)
        .run(move |cx| {
            gpui_kit::init(cx);
            // Desktop's mono stack falls through to `ui-monospace` (SF Mono),
            // which is not a public family name — register the system file.
            if let Ok(bytes) = std::fs::read("/System/Library/Fonts/SFNSMono.ttf") {
                cx.text_system()
                    .add_fonts(vec![std::borrow::Cow::Owned(bytes)])
                    .ok();
            }
            {
                let theme = gpui_kit::component::Theme::global_mut(cx);
                theme.font_family = theme::FONT_SANS.into();
                theme.mono_font_family = theme::FONT_MONO.into();
            }
            gpui_kit::open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                        None,
                        size(px(Layout::WINDOW_W), px(Layout::WINDOW_H)),
                        cx,
                    ))),
                    titlebar: Some(TitlebarOptions {
                        title: Some("TeamClu · home spike (1:1 shell)".into()),
                        appears_transparent: true,
                        traffic_light_position: Some(point(px(19.), px(19.))),
                    }),
                    ..Default::default()
                },
                cx,
                |window, cx| cx.new(|cx| SpikeApp::new(window, cx)),
            )
            .expect("open window");
        });
}
