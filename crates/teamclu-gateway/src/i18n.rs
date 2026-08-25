use std::sync::atomic::{AtomicU8, Ordering};

/// Supported locales
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Locale {
    En = 0,
    ZhCN = 1,
}

impl Locale {
    pub fn parse_or_default(s: &str) -> Locale {
        match s {
            "zh-CN" | "zh" | "zh-cn" => Locale::ZhCN,
            _ => Locale::En,
        }
    }
}

/// The language every gateway replies in — one device-wide value, mirroring the
/// app's UI language.
///
/// It used to be read per message out of the conversation workspace's
/// `<workspace>/.teamclu/teamclu.json`, which quietly guaranteed English: the gateways run
/// inside amuxd and were handed the daemon's own state directory, never the
/// workspace whose language the user had actually set. Language is an app-level
/// preference anyway — one setting, not one per workspace — so it lives here and
/// the daemon pushes it in from `daemon.toml` (see `set_locale`).
static GLOBAL_LOCALE: AtomicU8 = AtomicU8::new(Locale::En as u8);

/// Set the device-wide gateway reply language. Called by amuxd at startup and
/// whenever the desktop app reports a language change; takes effect on the next
/// reply, with no channel restart.
pub fn set_locale(locale: Locale) {
    GLOBAL_LOCALE.store(locale as u8, Ordering::Relaxed);
}

/// The current gateway reply language (`Locale::En` until something sets it).
pub fn locale() -> Locale {
    if GLOBAL_LOCALE.load(Ordering::Relaxed) == Locale::ZhCN as u8 {
        Locale::ZhCN
    } else {
        Locale::En
    }
}

/// All translatable message keys
pub enum MsgKey<'a> {
    // === Shared: /model command ===
    CurrentModelCustom(&'a str),
    CurrentModelDefault(&'a str),
    AvailableModels,
    ModelSwitchUsage,
    ModelSwitched(&'a str),
    ModelResetToDefault,
    ModelNotFound(&'a str),
    FailedToGetModels(&'a str),
    ModelListTruncated,
    ModelCurrentMarker,

    // === Shared: /sessions command ===
    NoSessionsFound,
    RecentSessions,
    Untitled,
    CurrentSessionMarker,
    SessionsSwitchUsage,
    InvalidSessionNumber(&'a str),
    SessionNotFound(usize, usize),
    SwitchedToSessionWithLatest(&'a str, &'a str),
    SwitchedToSessionNoLatest(&'a str),
    FailedToListSessions(&'a str),
    NoAssistantMessages,

    // === Shared: /stop command ===
    NoActiveSession,
    SessionStopped,
    FailedToStopSession(&'a str),
    FailedToStopSessionWithStatus(u16, &'a str),

    // === Shared: time formatting ===
    JustNow,
    MinAgo(i64),
    HrAgo(i64),
    DayAgo(i64),

    // === Shared: session reset ===
    SessionReset,

    // === Shared: /answer responses ===
    AnswerSubmitted(&'a str),
    NoPendingQuestions,

    // === Shared: pending question prompt ===
    PendingQuestionUsage,
    PendingQuestionExample(&'a str),
    PendingQuestionMultiUsage,
    PendingQuestionMultiExample(&'a str),

    // === Queue messages (WeChat, WeCom) ===
    QueueTimeout,
    QueueFull,
    GatewayShuttingDown,
    MessageCouldNotBeProcessed,

    // === Inbound attachments ===
    AttachmentFailed(&'a str),

    // === Error fallback ===
    ModelEmptyResponse,

    // === Unknown command ===
    UnknownCommand(&'a str),

    // === Gateway meta-commands (commands.rs: /help, /model, /sessions,
    // /workspace, /skills, /new, /stop, /ctx) ===
    GatewayMetaHelpStatic,
    AgentCommandsHeader,
    CtxUsage,
    NoModelsAvailable,
    CurrentModelCatalogUnavailable(&'a str),
    CurrentModelHeader(&'a str),
    ModelsListHeader,
    ModelsMoreIndented(usize),
    ModelUsageLine,
    CurrentMarkerParen,
    ModelSetConfirm(&'a str, &'a str),
    NoSessions,
    SessionsListHeader,
    SessionsUsageLine,
    NoSessionNumber(usize, usize),
    AlreadyInSession,
    SwitchedToSessionMeta(&'a str),
    CannotSwitchSession,
    NoWorkspaces,
    WorkspacesListHeader,
    WorkspacesUsageLine,
    NoWorkspaceNumber(usize, usize),
    DefaultWorkspaceSet(&'a str),
    NoSkillsFound,
    SkillsListHeader,
    NoParticipants,
    ParticipantsListHeader,
    /// Label for an `actors.actor_type`. Unknown kinds fall through as-is, so a
    /// participant whose type this build predates still lists.
    ParticipantKind(&'a str),
    /// A seat the actor directory could not name, carrying the head of its
    /// actor id so two of them stay distinguishable.
    UnnamedParticipant(&'a str),
    NewSessionStarted,
    NewSessionNotDetached,
    MetaStopped,
    NothingRunning,
    /// Someone wrote again while the previous turn was still running.
    /// Pairs with the existing `QueueFull` / `QueueTimeout` above.
    QueuedBehind(usize),
    ContextInjected,

    // === /reset ===
    SessionResetShort,
    CouldNotReset(&'a str),

    // === resolve_bare_model (commands.rs) ===
    ModelNotFoundInWorkspace(&'a str),
    ModelAmbiguous(&'a str, &'a str),

    // === misc shared across gateways ===

    // === /help per-gateway ===

    // === WeCom welcome ===
    WecomWelcome,
    // === Discord specific ===

    // === KOOK card-specific ===
}

/// Return the translated string for a given key and locale
pub fn t(key: MsgKey, locale: Locale) -> String {
    use Locale::*;
    use MsgKey::*;
    match (key, locale) {
        // === /model command ===
        (CurrentModelCustom(m), En) => format!("**Current Model:** `{}` (custom)\n\n", m),
        (CurrentModelCustom(m), ZhCN) => format!("**当前模型:** `{}` (自定义)\n\n", m),

        (CurrentModelDefault(m), En) => format!("**Current Model:** `{}` (default)\n\n", m),
        (CurrentModelDefault(m), ZhCN) => format!("**当前模型:** `{}` (默认)\n\n", m),

        (AvailableModels, En) => "**Available Models:**\n".into(),
        (AvailableModels, ZhCN) => "**可用模型:**\n".into(),

        (ModelSwitchUsage, En) => "\n\nUse `/model <provider/model>` to switch.\nUse `/model default` to reset to default.".into(),
        (ModelSwitchUsage, ZhCN) => "\n\n使用 `/model <provider/model>` 切换模型。\n使用 `/model default` 恢复默认。".into(),

        (ModelSwitched(m), En) => format!("Model switched to: `{}`\nAll subsequent messages in this context will use this model.", m),
        (ModelSwitched(m), ZhCN) => format!("模型已切换为: `{}`\n后续消息将使用此模型。", m),

        (ModelResetToDefault, En) => "Model reset to default. Subsequent messages will use the global default model.".into(),
        (ModelResetToDefault, ZhCN) => "已恢复默认模型，后续消息将使用全局默认模型。".into(),

        (ModelNotFound(m), En) => format!("Model `{}` not found. Use `/model` to see available models.", m),
        (ModelNotFound(m), ZhCN) => format!("模型 `{}` 未找到。使用 `/model` 查看可用模型。", m),

        (FailedToGetModels(e), En) => format!("Failed to get models: {}", e),
        (FailedToGetModels(e), ZhCN) => format!("获取模型列表失败: {}", e),

        (ModelListTruncated, En) => "\n_(List truncated due to length. Visit OpenCode UI for full model list.)_".into(),
        (ModelListTruncated, ZhCN) => "\n_(列表过长已截断，请在 OpenCode 界面查看完整列表。)_".into(),

        (ModelCurrentMarker, En) => " ← current".into(),
        (ModelCurrentMarker, ZhCN) => " ← 当前".into(),

        // === /sessions command ===
        (NoSessionsFound, En) => "No sessions found.".into(),
        (NoSessionsFound, ZhCN) => "暂无会话。".into(),

        (RecentSessions, En) => "**Recent Sessions:**\n".into(),
        (RecentSessions, ZhCN) => "**最近会话:**\n".into(),

        (Untitled, En) => "(untitled)".into(),
        (Untitled, ZhCN) => "(无标题)".into(),

        (CurrentSessionMarker, En) => "  <-- current".into(),
        (CurrentSessionMarker, ZhCN) => "  <-- 当前".into(),

        (SessionsSwitchUsage, En) => "\nUse `/sessions <number>` to switch.".into(),
        (SessionsSwitchUsage, ZhCN) => "\n使用 `/sessions <编号>` 切换会话。".into(),

        (InvalidSessionNumber(s), En) => format!("`{}` is not a valid session number. Use `/sessions` to see the list.", s),
        (InvalidSessionNumber(s), ZhCN) => format!("`{}` 不是有效的会话编号。使用 `/sessions` 查看列表。", s),

        (SessionNotFound(num, total), En) => format!("Session #{} not found. There are only {} sessions.", num, total),
        (SessionNotFound(num, total), ZhCN) => format!("会话 #{} 不存在，当前共有 {} 个会话。", num, total),

        (SwitchedToSessionWithLatest(title, latest), En) => {
            format!("Switched to session: \"{}\"\n\n**Latest response:**\n{}", title, latest)
        }
        (SwitchedToSessionWithLatest(title, latest), ZhCN) => {
            format!("已切换到会话: \"{}\"\n\n**最近回复:**\n{}", title, latest)
        }

        (SwitchedToSessionNoLatest(title), En) => {
            format!("Switched to session: \"{}\"\n\nSubsequent messages will be sent to this session.", title)
        }
        (SwitchedToSessionNoLatest(title), ZhCN) => {
            format!("已切换到会话: \"{}\"\n\n后续消息将发送到此会话。", title)
        }

        (FailedToListSessions(e), En) => format!("Failed to list sessions: {}", e),
        (FailedToListSessions(e), ZhCN) => format!("获取会话列表失败: {}", e),

        (NoAssistantMessages, En) => "(no assistant messages yet)".into(),
        (NoAssistantMessages, ZhCN) => "(暂无助手消息)".into(),

        // === /stop command ===
        (NoActiveSession, En) => "No active session. Nothing to stop.".into(),
        (NoActiveSession, ZhCN) => "没有活跃会话，无需停止。".into(),

        (SessionStopped, En) => "Session processing stopped.".into(),
        (SessionStopped, ZhCN) => "会话处理已停止。".into(),

        (FailedToStopSession(e), En) => format!("Failed to stop session: {}", e),
        (FailedToStopSession(e), ZhCN) => format!("停止会话失败: {}", e),

        (FailedToStopSessionWithStatus(status, body), En) => format!("Failed to stop session ({}): {}", status, body),
        (FailedToStopSessionWithStatus(status, body), ZhCN) => format!("停止会话失败 ({}): {}", status, body),

        // === Time formatting ===
        (JustNow, En) => "just now".into(),
        (JustNow, ZhCN) => "刚刚".into(),

        (MinAgo(n), En) => format!("{} min ago", n),
        (MinAgo(n), ZhCN) => format!("{} 分钟前", n),

        (HrAgo(n), En) => format!("{} hr ago", n),
        (HrAgo(n), ZhCN) => format!("{} 小时前", n),

        (DayAgo(n), En) => format!("{} day ago", n),
        (DayAgo(n), ZhCN) => format!("{} 天前", n),

        // === Session reset ===
        (SessionReset, En) => "Session reset. Next message will start a new conversation.".into(),
        (SessionReset, ZhCN) => "会话已重置，下一条消息将开始新对话。".into(),

        // === /answer responses ===
        (AnswerSubmitted(text), En) => format!("✓ Answered: {}", text),
        (AnswerSubmitted(text), ZhCN) => format!("✓ 已回复: {}", text),

        (NoPendingQuestions, En) => "No pending questions to answer.".into(),
        (NoPendingQuestions, ZhCN) => "当前没有待回复的问题。".into(),

        // === Pending question prompt ===
        (PendingQuestionUsage, En) => "Reply with /answer <number or text>, valid for 5 minutes\n".into(),
        (PendingQuestionUsage, ZhCN) => "请用 /answer <序号或内容> 回复，5分钟内有效\n".into(),

        (PendingQuestionExample(qid), En) => format!("e.g.: /answer 1\n[Q:{}]", qid),
        (PendingQuestionExample(qid), ZhCN) => format!("例如: /answer 1\n[Q:{}]", qid),

        (PendingQuestionMultiUsage, En) => "Reply with /answer <ans1; ans2; ...>, use ; to separate answers for each question\n".into(),
        (PendingQuestionMultiUsage, ZhCN) => "请用 /answer <答案1; 答案2; ...> 回复，用 ; 分隔每个问题的答案\n".into(),

        (PendingQuestionMultiExample(qid), En) => format!("e.g.: /answer 1; 2\n[Q:{}]", qid),
        (PendingQuestionMultiExample(qid), ZhCN) => format!("例如: /answer 1; 2\n[Q:{}]", qid),

        // === Queue messages ===
        (QueueTimeout, En) => "Message queue timeout, please try again.".into(),
        (QueueTimeout, ZhCN) => "消息排队超时，请重试。".into(),

        (QueueFull, En) => "Too many messages, please wait.".into(),
        (QueueFull, ZhCN) => "消息过多，请稍候。".into(),

        (GatewayShuttingDown, En) => "Gateway is shutting down.".into(),
        (GatewayShuttingDown, ZhCN) => "网关正在关闭。".into(),

        (MessageCouldNotBeProcessed, En) => "Your message could not be processed. Please resend.".into(),
        (MessageCouldNotBeProcessed, ZhCN) => "消息处理失败，请重新发送。".into(),

        // === Inbound attachments ===
        (AttachmentFailed(e), En) => format!("I couldn't retrieve the attachment you sent ({}). Please send it again.", e),
        (AttachmentFailed(e), ZhCN) => format!("你发来的附件没能取到（{}），请再发一次。", e),

        // === Error fallback ===
        (ModelEmptyResponse, En) => "The model returned no text content. Please try again or rephrase.".into(),
        (ModelEmptyResponse, ZhCN) => "模型未返回文字内容，请稍后重试或换种说法。".into(),

        // === Unknown command ===
        (UnknownCommand(cmd), En) => format!("Unknown command: {}\nType /help for available commands.", cmd),
        (UnknownCommand(cmd), ZhCN) => format!("未知命令: {}\n输入 /help 查看可用命令。", cmd),

        // === Gateway meta-commands (commands.rs) ===
        (GatewayMetaHelpStatic, En) => "\
            Gateway commands:\n\
            /help - Show this help\n\
            /model [name] - List or switch models\n\
            /sessions [n] - List this chat's sessions, or continue #n\n\
            /workspace [n] - List workspaces, or make #n this bot's default\n\
            /skills - List workspace skills\n\
            /participant - List everyone in this chat\n\
            /new - Start a new session (the current one stays in /sessions)\n\
            /reset - Clear the agent's context, staying in this session\n\
            /stop - Stop current processing\n\
            /ctx <text> - Inject context without reply".into(),
        (GatewayMetaHelpStatic, ZhCN) => "\
            网关命令:\n\
            /help - 显示本帮助\n\
            /model [名称] - 查看或切换模型\n\
            /sessions [编号] - 查看本聊天的会话列表，或切换到第 n 个\n\
            /workspace [编号] - 查看工作区列表，或将第 n 个设为此机器人的默认工作区\n\
            /skills - 查看工作区技能列表\n\
            /participant - 查看本会话的所有成员\n\
            /new - 开始新会话（当前会话仍保留在 /sessions 中）\n\
            /reset - 清空 Agent 上下文，但留在当前会话\n\
            /stop - 停止当前处理\n\
            /ctx <文本> - 注入上下文但不回复".into(),

        (AgentCommandsHeader, En) => "\n\nAgent commands:".into(),
        (AgentCommandsHeader, ZhCN) => "\n\nAgent 命令:".into(),

        (CtxUsage, En) => "Usage: /ctx <text>".into(),
        (CtxUsage, ZhCN) => "用法: /ctx <文本>".into(),

        (NoModelsAvailable, En) => "No models available.".into(),
        (NoModelsAvailable, ZhCN) => "暂无可用模型。".into(),

        (CurrentModelCatalogUnavailable(m), En) => format!("Current model: {}\n(Model catalog unavailable.)", m),
        (CurrentModelCatalogUnavailable(m), ZhCN) => format!("当前模型: {}\n（模型列表不可用。）", m),

        (CurrentModelHeader(m), En) => format!("Current model: {}\n\n", m),
        (CurrentModelHeader(m), ZhCN) => format!("当前模型: {}\n\n", m),

        (ModelsListHeader, En) => "Models:\n".into(),
        (ModelsListHeader, ZhCN) => "模型列表:\n".into(),

        (ModelsMoreIndented(n), En) => format!("\n  … and {} more", n),
        (ModelsMoreIndented(n), ZhCN) => format!("\n  ……以及另外 {} 个", n),

        (ModelUsageLine, En) => "\n\nUsage: /model <provider>/<model>".into(),
        (ModelUsageLine, ZhCN) => "\n\n用法: /model <provider>/<model>".into(),

        (CurrentMarkerParen, En) => " (current)".into(),
        (CurrentMarkerParen, ZhCN) => "（当前）".into(),

        (ModelSetConfirm(p, m), En) => format!("Model set: {}/{}", p, m),
        (ModelSetConfirm(p, m), ZhCN) => format!("已设置模型: {}/{}", p, m),

        (NoSessions, En) => "No sessions.".into(),
        (NoSessions, ZhCN) => "暂无会话。".into(),

        (SessionsListHeader, En) => "Sessions:\n".into(),
        (SessionsListHeader, ZhCN) => "会话列表:\n".into(),

        (SessionsUsageLine, En) => "\n\nUsage: /sessions <number> — continue that conversation".into(),
        (SessionsUsageLine, ZhCN) => "\n\n用法: /sessions <编号> — 继续该会话".into(),

        (NoSessionNumber(n, total), En) => format!("No session #{}. Use /sessions to list them ({} available).", n, total),
        (NoSessionNumber(n, total), ZhCN) => format!("没有第 #{} 个会话。使用 /sessions 查看列表（共 {} 个）。", n, total),

        (AlreadyInSession, En) => "Already in this session.".into(),
        (AlreadyInSession, ZhCN) => "已经在此会话中。".into(),

        (SwitchedToSessionMeta(title), En) => format!("Switched to: {}\nThe next message continues that conversation.", title),
        (SwitchedToSessionMeta(title), ZhCN) => format!("已切换到: {}\n下一条消息将继续该会话。", title),

        (CannotSwitchSession, En) => "Cannot switch to that session — it is not one of this chat's. Use /sessions to list them.".into(),
        (CannotSwitchSession, ZhCN) => "无法切换到该会话——它不属于本聊天。使用 /sessions 查看列表。".into(),

        (NoWorkspaces, En) => "No workspaces.".into(),
        (NoWorkspaces, ZhCN) => "暂无工作区。".into(),

        (WorkspacesListHeader, En) => "Workspaces:\n".into(),
        (WorkspacesListHeader, ZhCN) => "工作区列表:\n".into(),

        (WorkspacesUsageLine, En) => "\n\nUsage: /workspace <number> — set this bot's default".into(),
        (WorkspacesUsageLine, ZhCN) => "\n\n用法: /workspace <编号> — 设为此机器人的默认工作区".into(),

        (NoWorkspaceNumber(n, total), En) => format!("No workspace #{}. Use /workspace to list them ({} available).", n, total),
        (NoWorkspaceNumber(n, total), ZhCN) => format!("没有第 #{} 个工作区。使用 /workspace 查看列表（共 {} 个）。", n, total),

        // Scoped to this chat and not durable since #933 — `/workspace` no
        // longer writes daemon.toml, so saying "default" would promise more
        // than it does.
        (DefaultWorkspaceSet(id), En) => {
            format!("Workspace for this chat: {} (until the daemon restarts)", id)
        }
        (DefaultWorkspaceSet(id), ZhCN) => {
            format!("本会话工作区已切换: {}（daemon 重启后失效）", id)
        }

        (NoSkillsFound, En) => "No workspace skills found.".into(),
        (NoSkillsFound, ZhCN) => "未找到工作区技能。".into(),

        (SkillsListHeader, En) => "Skills:\n".into(),
        (SkillsListHeader, ZhCN) => "技能列表:\n".into(),

        (NoParticipants, En) => "No one is in this chat yet.".into(),
        (NoParticipants, ZhCN) => "本会话暂无成员。".into(),

        (ParticipantsListHeader, En) => "In this chat:\n".into(),
        (ParticipantsListHeader, ZhCN) => "本会话成员:\n".into(),

        // The actor vocabulary the product uses: "member" and "agent" are the
        // two actor types a person meets, "external" is a chat identity with no
        // TeamClu account behind it.
        (ParticipantKind("member"), En) => "member".into(),
        (ParticipantKind("member"), ZhCN) => "成员".into(),
        (ParticipantKind("agent"), En) => "agent".into(),
        (ParticipantKind("agent"), ZhCN) => "Agent".into(),
        (ParticipantKind("external"), En) => "external".into(),
        (ParticipantKind("external"), ZhCN) => "外部".into(),
        (ParticipantKind(other), _) => other.to_string(),

        (UnnamedParticipant(short_id), En) => format!("unnamed participant ({})", short_id),
        (UnnamedParticipant(short_id), ZhCN) => format!("未知成员（{}）", short_id),

        (NewSessionStarted, En) => "Started a new session. The next message begins a fresh conversation (/sessions to go back to this one).".into(),
        (NewSessionStarted, ZhCN) => "已开始新会话。下一条消息将开始全新对话（可用 /sessions 返回原会话）。".into(),

        (NewSessionNotDetached, En) => "Could not start a new session — this chat is still on the same one. The agent's context was cleared, but its history is unchanged.".into(),
        (NewSessionNotDetached, ZhCN) => "无法开始新会话——本聊天仍在原会话中。Agent 上下文已清空，但历史记录未变。".into(),

        (MetaStopped, En) => "Stopped.".into(),
        (MetaStopped, ZhCN) => "已停止。".into(),

        (NothingRunning, En) => "Nothing running.".into(),
        (NothingRunning, ZhCN) => "当前没有正在运行的任务。".into(),

        (QueuedBehind(n), En) => format!(
            "Still working on the previous message — yours is queued ({} ahead). `/stop` cancels the current one.",
            n
        ),
        (QueuedBehind(n), ZhCN) => format!(
            "上一条还在处理，这条已排队（前面还有 {} 条）。想取消当前这条可以发 `/stop`。",
            n
        ),


        (ContextInjected, En) => "Context injected.".into(),
        (ContextInjected, ZhCN) => "已注入上下文。".into(),

        // === Shared session-slash dispatcher ===


        (SessionResetShort, En) => "🔄 Session reset. Next message starts fresh.".into(),
        (SessionResetShort, ZhCN) => "🔄 会话已重置。下一条消息将开始新对话。".into(),

        (CouldNotReset(e), En) => format!("⚠️ Could not reset: {}", e),
        (CouldNotReset(e), ZhCN) => format!("⚠️ 无法重置: {}", e),








        // === resolve_bare_model ===
        (ModelNotFoundInWorkspace(name), En) => format!("Unknown model: {}. Use /model to list what this workspace offers, or give the full id: /model <provider>/<model>.", name),
        (ModelNotFoundInWorkspace(name), ZhCN) => format!("未知模型: {}。使用 /model 查看本工作区提供的模型，或给出完整 id: /model <provider>/<model>。", name),

        (ModelAmbiguous(name, providers), En) => format!("Ambiguous model: {} is offered by {}. Use the full id: /model <provider>/{}.", name, providers, name),
        (ModelAmbiguous(name, providers), ZhCN) => format!("模型不明确: {} 由以下提供方提供: {}。请使用完整 id: /model <provider>/{}。", name, providers, name),

        // === misc shared ===


        // === /help per-gateway ===




        // === WeCom welcome ===
        (WecomWelcome, En) => "Hello! I'm an AI assistant. Send me a message to start a conversation, or type /help for available commands.".into(),
        (WecomWelcome, ZhCN) => "你好！我是 AI 助手。直接发消息给我开始对话，发送 /help 查看可用命令。".into(),

        // === Discord specific ===

        // === KOOK card-specific ===



    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_defaults_to_english_and_follows_set_locale() {
        // The daemon pushes this in from daemon.toml; until it does, replies are
        // English rather than whatever the last workspace happened to say.
        assert_eq!(locale(), Locale::En);

        set_locale(Locale::ZhCN);
        assert_eq!(locale(), Locale::ZhCN);
        assert_eq!(t(MsgKey::NoSessions, locale()), "暂无会话。");

        set_locale(Locale::En);
        assert_eq!(locale(), Locale::En);
    }

    #[test]
    fn unknown_language_tags_fall_back_to_english() {
        assert_eq!(Locale::parse_or_default("zh-CN"), Locale::ZhCN);
        assert_eq!(Locale::parse_or_default("zh"), Locale::ZhCN);
        assert_eq!(Locale::parse_or_default("ja-JP"), Locale::En);
        assert_eq!(Locale::parse_or_default(""), Locale::En);
    }
}
