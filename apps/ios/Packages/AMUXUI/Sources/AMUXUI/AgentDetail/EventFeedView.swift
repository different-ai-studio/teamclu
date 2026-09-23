import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

// MARK: - CachedActorMap

/// Lightweight snapshot of actorID → displayName, built once at the parent
/// from a single `@Query` and passed down so each bubble doesn't register
/// its own SwiftData observation. With 100 visible bubbles the old approach
/// caused 100 separate re-renders on every CachedActor change.
public struct CachedActorMap: Sendable {
    public static let empty = CachedActorMap(nameByActorID: [:])
    public let nameByActorID: [String: String]
    public init(nameByActorID: [String: String]) { self.nameByActorID = nameByActorID }
    public func displayName(for actorID: String) -> String? { nameByActorID[actorID] }
}

// MARK: - EventBubbleView

public struct EventBubbleView: View {
    let event: AgentEvent
    let runtime: AgentAttachment?
    let onGrant: ((String, String?) -> Void)?
    let onDeny: ((String, String?) -> Void)?
    /// Option-aware grant: (requestId, optionId, senderActorID). Falls back
    /// to `onGrant` when nil so older call sites keep working.
    let onGrantOption: ((String, String, String?) -> Void)?
    /// Lookup for the ACP option list of a pending permission request,
    /// keyed by requestID. Nil renders the legacy binary Allow/Deny pair.
    let permissionOptions: ((String) -> [PermissionOptionItem])?
    /// Tap handler invoked when the user taps a `.failed` outbox dot on
    /// their own bubble. Hooked to `OutboxSender.retry` by the parent.
    let onRetryOutbox: ((String) -> Void)?
    /// When false the assistant bubble suppresses its "{Agent} · {Model}"
    /// caption. Used by `StreamingDetailView`, where the same identity is
    /// already painted into the nav-bar title for the whole turn so the
    /// per-bubble caption would just be redundant.
    let showsAssistantHeader: Bool
    /// When false the assistant bubble leaves its attachments to the parent.
    /// `StreamingDetailView` collects the whole turn's files and renders them
    /// once at the end, so rendering them here too would double them up.
    var showsAttachments: Bool = true
    /// Actor map built by the parent once per recomputeGroups cycle.
    /// Replaces the per-row @Query(CachedActor) so ~100 bubbles don't
    /// each register a SwiftData observation.
    let actorMap: CachedActorMap
    /// Context-menu hooks for the user's own persisted prompts. The parent
    /// decides eligibility (own message + supabaseMessageId present) and
    /// passes nil otherwise, so the bubble never has to reason about
    /// identity or persistence state itself.
    let onEdit: (() -> Void)?
    let onDelete: (() -> Void)?
    /// Quoted message when this event is a reply (resolved by the parent
    /// from the SessionMessage mirror). Renders as a chip above the bubble;
    /// tapping invokes `onTapQuote` (jump to the quoted message).
    let replyQuote: SessionDetailViewModel.ReplyQuote?
    let onTapQuote: (() -> Void)?

    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var fullscreenImageContext: FullscreenImageContext?
    /// Separate from `fullscreenImageContext`: that viewer pages through the
    /// local outbox by URL, which a message-carried attachment has no place
    /// in — it is addressed by bucket path and fetched with a bearer.
    @State private var fullscreenAttachment: MessageAttachment?

    public init(event: AgentEvent, runtime: AgentAttachment? = nil,
                onGrant: ((String, String?) -> Void)? = nil,
                onDeny: ((String, String?) -> Void)? = nil,
                onGrantOption: ((String, String, String?) -> Void)? = nil,
                permissionOptions: ((String) -> [PermissionOptionItem])? = nil,
                onRetryOutbox: ((String) -> Void)? = nil,
                showsAssistantHeader: Bool = true,
                showsAttachments: Bool = true,
                actorMap: CachedActorMap = .empty,
                onEdit: (() -> Void)? = nil,
                onDelete: (() -> Void)? = nil,
                replyQuote: SessionDetailViewModel.ReplyQuote? = nil,
                onTapQuote: (() -> Void)? = nil) {
        self.event = event
        self.runtime = runtime
        self.onGrant = onGrant
        self.onDeny = onDeny
        self.onGrantOption = onGrantOption
        self.permissionOptions = permissionOptions
        self.onRetryOutbox = onRetryOutbox
        self.showsAssistantHeader = showsAssistantHeader
        self.showsAttachments = showsAttachments
        self.actorMap = actorMap
        self.onEdit = onEdit
        self.onDelete = onDelete
        self.replyQuote = replyQuote
        self.onTapQuote = onTapQuote
    }

    /// True when this event was produced by an actor other than the
    /// signed-in user. Drives the "You / @other" label and bubble tint
    /// for user-prompt rows.
    private var isFromOtherUser: Bool {
        guard let senderID = event.senderActorID, !senderID.isEmpty else { return false }
        return senderID != currentActorID
    }

    private var currentActorID: String? {
        // The detail surface lives inside RootTabView's scope, which
        // installs the AppOnboardingCoordinator into the environment.
        // We pull the active actor id directly from there so the bubble
        // identity question — "did I send this?" — has a single source
        // of truth that matches the rest of the app.
        coordinator?.currentContext?.memberActorID
    }

    @Environment(AppOnboardingCoordinator.self) private var coordinator: AppOnboardingCoordinator?

    private var senderDisplayName: String {
        guard let senderID = event.senderActorID, !senderID.isEmpty else { return String(localized: "You") }
        if senderID == currentActorID { return String(localized: "You") }
        if let name = actorMap.displayName(for: senderID) { return name }
        return String(senderID.prefix(8))
    }

    /// Display name for the model that produced this event (assistant reply
    /// types only). Returns nil for non-stamped events or when no runtime is
    /// available to resolve the display name.
    private var modelDisplayName: String? {
        guard let runtime else { return nil }
        return event.modelDisplayName(via: runtime)
    }

    /// Header label shown above an assistant bubble: "{Agent name} · {Model}"
    /// when both are resolvable, the agent name alone when the model isn't
    /// stamped, the model alone when the agent identity can't be resolved
    /// (e.g. event was stamped with a runtime_id before the runtime→actor
    /// mapping was available), nil when neither resolves. Caption-style at
    /// the call site.
    private var assistantHeaderLabel: String? {
        let agent = senderDisplayName.isEmpty ? nil : senderDisplayName
        let model = modelDisplayName
        switch (agent, model) {
        case let (.some(a), .some(m)): return "\(a) · \(m)"
        case let (.some(a), .none): return a
        case let (.none, .some(m)): return m
        case (.none, .none): return nil
        }
    }

    public var body: some View {
        Group {
            switch event.eventType {
            case "user_prompt":
                userBubble
            case "output":
                assistantBubble
            case "thinking":
                thinkingBlock
            case "tool_use":
                toolUseBlock
            case "tool_result":
                EmptyView()
            case "error":
                errorBlock
            case "permission_request":
                PermissionBannerView(
                    toolName: event.toolName ?? "",
                    description: event.text ?? "",
                    requestId: event.toolId ?? "",
                    isResolved: event.isComplete == true,
                    wasGranted: event.success,
                    options: event.isComplete == true ? [] : (permissionOptions?(event.toolId ?? "") ?? []),
                    onSelect: event.isComplete == true ? nil : { option in
                        let requestID = event.toolId ?? ""
                        if option.isReject {
                            onDeny?(requestID, event.senderActorID)
                        } else if let onGrantOption {
                            onGrantOption(requestID, option.id, event.senderActorID)
                        } else {
                            onGrant?(requestID, event.senderActorID)
                        }
                    },
                    onGrant: event.isComplete == true ? nil : { id in onGrant?(id, event.senderActorID) },
                    onDeny: event.isComplete == true ? nil : { id in onDeny?(id, event.senderActorID) }
                )
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
            default:
                EmptyView()
            }
        }
        .fullScreenCover(item: $fullscreenImageContext) { ctx in
            FullScreenSessionImageViewer(sessionID: ctx.sessionID, initialURL: ctx.initialURL)
        }
        .fullScreenCover(item: $fullscreenAttachment) { item in
            FullScreenAttachmentViewer(attachment: item)
        }
    }

    // MARK: - User Bubble
    //
    // Every human sits on the right; agents keep the left. The edge says
    // "person or agent", the color says whose: the local user gets the
    // Cinnabar-tinted glass with a "You" label, another collaborator a
    // slate-tinted glass under their display name.

    private var userBubble: some View {
        if isFromOtherUser {
            return AnyView(otherUserBubble)
        } else {
            return AnyView(selfUserBubble)
        }
    }

    private var selfUserBubble: some View {
        let parsed = ParsedMessageContent.parse(event.text ?? "")
        return VStack(alignment: .trailing, spacing: 2) {
            Text("You")
                .font(.caption)
                .foregroundStyle(Color.amux.basalt)
                .padding(.trailing, 4)

            HStack(alignment: .bottom, spacing: 0) {
                Spacer(minLength: 0)
                HStack(alignment: .bottom, spacing: 6) {
                    if let outboxID = event.outboxMessageID {
                        OutboxStatusDot(outboxMessageID: outboxID, onRetry: onRetryOutbox)
                    }
                    VStack(alignment: .trailing, spacing: 6) {
                        if let replyQuote {
                            ReplyQuoteChip(
                                quote: replyQuote,
                                actorMap: actorMap,
                                alignment: .trailing,
                                onTap: onTapQuote
                            )
                        }
                        if let outboxID = event.outboxMessageID {
                            SentAttachmentsView(outboxMessageID: outboxID) { url, sid in
                                fullscreenImageContext = FullscreenImageContext(
                                    initialURL: url, sessionID: sid
                                )
                            }
                        }
                        ForEach(Array(parsed.imageURLs.enumerated()), id: \.offset) { _, url in
                            AsyncImage(url: url) { phase in
                                switch phase {
                                case .success(let image):
                                    image.resizable().scaledToFit()
                                        .clipShape(RoundedRectangle(cornerRadius: 12))
                                default:
                                    RoundedRectangle(cornerRadius: 12)
                                        .fill(Color.amux.pebble)
                                        .overlay(ProgressView())
                                        .frame(height: 150)
                                }
                            }
                        }
                        ForEach(Array(parsed.fileURLs.enumerated()), id: \.offset) { _, url in
                            AttachmentFileCard(url: url)
                        }
                        if !parsed.text.isEmpty {
                            Text(Self.displayText(parsed.text))
                                .font(.subheadline)
                                .foregroundStyle(Color.amux.mist)
                                .textSelection(.enabled)
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .liquidGlass(in: RoundedRectangle(cornerRadius: 18),
                                             tint: Color.amux.cinnabar,
                                             interactive: false)
                                .contextMenu {
                                    MessageContextMenu(text: MentionDisplayText.plainText(event.text ?? ""))
                                    if onEdit != nil || onDelete != nil {
                                        Divider()
                                    }
                                    if let onEdit {
                                        Button {
                                            onEdit()
                                        } label: {
                                            Label("Edit", systemImage: "pencil")
                                        }
                                    }
                                    if let onDelete {
                                        Button(role: .destructive) {
                                            onDelete()
                                        } label: {
                                            Label("Delete", systemImage: "trash")
                                        }
                                    }
                                }
                        }
                    }
                }
                .frame(maxWidth: sizeClass == .regular ? 500 : 260, alignment: .trailing)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }

    private var otherUserBubble: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(senderDisplayName)
                .font(.caption)
                .foregroundStyle(Color.amux.basalt)
                .padding(.trailing, 4)

            HStack(spacing: 0) {
                Spacer(minLength: 0)
                VStack(alignment: .trailing, spacing: 6) {
                    if let replyQuote {
                        ReplyQuoteChip(
                            quote: replyQuote,
                            actorMap: actorMap,
                            alignment: .trailing,
                            onTap: onTapQuote
                        )
                    }
                    Text(Self.displayText(event.text ?? ""))
                        .font(.subheadline)
                        .foregroundStyle(Color.amux.onyx)
                        .textSelection(.enabled)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .liquidGlass(in: RoundedRectangle(cornerRadius: 18),
                                     tint: Color.amux.slate,
                                     interactive: false)
                        .contextMenu {
                            MessageContextMenu(text: MentionDisplayText.plainText(event.text ?? ""))
                        }
                }
                .frame(maxWidth: sizeClass == .regular ? 500 : 260, alignment: .trailing)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }

    /// A human message with the desktop's mention/skill tokens rewritten
    /// (`[Mentioned: X|instruction: …]` → `@X`). The tokens are set in
    /// semibold rather than a color: the bubble tint already carries color,
    /// and weight reads on both the cinnabar and the slate glass.
    static func displayText(_ raw: String) -> AttributedString {
        var result = AttributedString()
        for segment in MentionDisplayText.segments(raw) {
            var run = AttributedString(segment.text)
            if segment.kind != .text {
                run.inlinePresentationIntent = .stronglyEmphasized
            }
            result += run
        }
        return result
    }

    // MARK: - Assistant Bubble (gray, left-aligned, markdown)

    private var assistantBubble: some View {
        VStack(alignment: .leading, spacing: 2) {
            if showsAssistantHeader, let header = assistantHeaderLabel {
                Text(header)
                    .font(.caption)
                    .foregroundStyle(Color.amux.basalt)
                    .padding(.leading, 4)
            }
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    MarkdownRenderer(content: event.text ?? "")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .liquidGlass(in: RoundedRectangle(cornerRadius: 18), interactive: false)
                .contextMenu {
                    MessageContextMenu(text: event.text ?? "")
                }
            }

            // Under the bubble, not inside it: the files are the message's,
            // not part of its prose, and a thumbnail inside the glass would
            // inherit its padding and corner.
            if showsAttachments, !event.attachments.isEmpty {
                MessageAttachmentsView(
                    attachments: event.attachments,
                    onTapImage: { fullscreenAttachment = $0 }
                )
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
    }

    // MARK: - Thinking Block

    private var thinkingBlock: some View {
        ThinkingBlockView(text: event.text ?? "")
            .contextMenu {
                MessageContextMenu(text: event.text ?? "")
            }
    }

    // MARK: - Tool Use

    private var toolUseBlock: some View {
        Group {
            if event.isComplete == true {
                CompactToolLine(event: event)
            } else {
                ToolCallView(
                    toolName: event.toolName ?? String(localized: "Unknown"),
                    toolId: event.toolId ?? "",
                    description: event.text ?? "",
                    status: "running"
                )
                .padding(.horizontal, 16)
                .padding(.vertical, 2)
            }
        }
        .contextMenu {
            MessageContextMenu(text: event.text ?? "")
        }
    }

    // MARK: - Error

    private var errorBlock: some View {
        ErrorBlockView(message: event.text ?? String(localized: "Unknown error"))
    }
}

// MARK: - ActiveStreamCardView
//
// Compact full-width card rendered for an agent whose runtime is still
// producing output. Replaces the live thinking/tool/output stream that
// used to clutter the main feed when multiple agents work in parallel.
// Tap routes to `StreamingDetailView` for the full event timeline.

public struct ActiveStreamCardView: View {
    public let agentName: String
    /// Latest single-line text drawn from (in priority): live streaming
    /// text buffer, the most recent runtime event's text, or "Working…"
    /// when nothing readable has arrived yet. Ignored when `isPending`
    /// is true — the placeholder label takes precedence there.
    public let lastLine: String
    /// True when the agent has been engaged (send tapped) but no ACP
    /// runtime event or text delta has come back yet. Drives the
    /// breathing-light color (cinnabar = waiting) and the placeholder
    /// label ("Agent loading…"). Flips false the moment the first event
    /// arrives, at which point the dot turns sage and the label switches
    /// to the live last-line preview.
    public let isPending: Bool

    @State private var pulse = false
    @State private var pendingElapsed: TimeInterval = 0
    @State private var pendingTicker: Timer? = nil

    /// Seconds the pending card must stay visible before its label
    /// switches from "Agent loading…" to the patience copy. Cold-spawn
    /// agents routinely take >10s before the first delta lands, so 15s
    /// is the point where the user starts to wonder if anything is happening.
    private static let patienceThreshold: TimeInterval = 15

    public init(agentName: String, lastLine: String, isPending: Bool = false) {
        self.agentName = agentName
        self.lastLine = lastLine
        self.isPending = isPending
    }

    private var dotColor: Color {
        isPending ? Color.amux.cinnabar : Color.amux.sage
    }

    private var displayText: String {
        if isPending {
            if pendingElapsed >= Self.patienceThreshold {
                return String(localized: "Agent is taking a while to start — hang tight…")
            }
            return String(localized: "Agent loading…")
        }
        return lastLine.isEmpty ? String(localized: "Working…") : lastLine
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(agentName)
                .font(.caption)
                .foregroundStyle(Color.amux.basalt)
                .padding(.leading, 4)

            HStack(alignment: .center, spacing: 10) {
                Circle()
                    .fill(dotColor)
                    .frame(width: 8, height: 8)
                    .scaleEffect(pulse ? 1.25 : 0.85)
                    .opacity(pulse ? 0.55 : 1.0)
                    .animation(AMUXAnimation.fast, value: dotColor)

                Text(displayText)
                    .font(.subheadline)
                    .foregroundStyle(Color.amux.onyx)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .liquidGlass(in: RoundedRectangle(cornerRadius: 18), interactive: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onAppear {
            withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                pulse.toggle()
            }
            if isPending { startPendingTicker() }
        }
        .onDisappear { stopPendingTicker() }
        .onChange(of: isPending) { _, nowPending in
            if nowPending {
                startPendingTicker()
            } else {
                stopPendingTicker()
                pendingElapsed = 0
            }
        }
    }

    private func startPendingTicker() {
        stopPendingTicker()
        let started = Date()
        pendingElapsed = 0
        pendingTicker = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
            Task { @MainActor in
                pendingElapsed = Date().timeIntervalSince(started)
            }
        }
    }

    private func stopPendingTicker() {
        pendingTicker?.invalidate()
        pendingTicker = nil
    }
}

// MARK: - CompletedTurnBubbleView
//
// Final assistant bubble for a completed turn. Same look as
// `EventBubbleView.assistantBubble` (gray glass, markdown, model caption)
// but with an extra detail-icon overlay bottom-right that pushes the
// streaming detail when the turn produced any thinking / tool runs the
// user might want to inspect. The turn's files sit directly under the
// bubble; the process page lists them too.

public struct CompletedTurnBubbleView<DetailIcon: View>: View {
    public let finalEvent: AgentEvent
    public let runtime: AgentAttachment?
    public let agentName: String?
    /// Optional content slot rendered bottom-right of the bubble. Used to
    /// host a `NavigationLink(value:)` so taps push the streaming detail
    /// — kept generic here so this view doesn't depend on the navigation
    /// route type defined in `StreamingDetailView.swift`.
    @ViewBuilder public let detailIcon: () -> DetailIcon
    /// Every file the turn produced, deduplicated by the parent. Rendered
    /// under the bubble so the reader doesn't have to open the process
    /// page to find what came out of the turn.
    public let attachments: [MessageAttachment]
    @State private var fullscreenAttachment: MessageAttachment?

    /// The signed-in user's feedback for this message ("positive" /
    /// "negative"), nil when none. Rendered as a small thumb next to the
    /// model caption; changed via the context menu.
    public let feedbackKind: String?
    /// Invoked with the desired kind; the parent owns toggle semantics
    /// (tapping the active kind again clears it).
    public let onFeedback: ((String) -> Void)?

    public init(finalEvent: AgentEvent,
                runtime: AgentAttachment?,
                agentName: String?,
                feedbackKind: String? = nil,
                onFeedback: ((String) -> Void)? = nil,
                attachments: [MessageAttachment] = [],
                @ViewBuilder detailIcon: @escaping () -> DetailIcon = { EmptyView() }) {
        self.finalEvent = finalEvent
        self.runtime = runtime
        self.agentName = agentName
        self.feedbackKind = feedbackKind
        self.onFeedback = onFeedback
        self.detailIcon = detailIcon
        self.attachments = attachments
    }

    private var modelDisplayName: String? {
        guard let runtime else { return nil }
        return finalEvent.modelDisplayName(via: runtime)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let agentName, !agentName.isEmpty {
                Text(agentName)
                    .font(.caption)
                    .foregroundStyle(Color.amux.basalt)
                    .padding(.leading, 4)
            }

            ZStack(alignment: .bottomTrailing) {
                VStack(alignment: .leading, spacing: 4) {
                    MarkdownRenderer(content: finalEvent.text ?? "")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .liquidGlass(in: RoundedRectangle(cornerRadius: 18), interactive: false)
                .contextMenu {
                    MessageContextMenu(text: finalEvent.text ?? "")
                    if let onFeedback {
                        Divider()
                        Button {
                            onFeedback("positive")
                        } label: {
                            Label(
                                feedbackKind == "positive" ? "Remove Helpful" : "Helpful",
                                systemImage: feedbackKind == "positive" ? "hand.thumbsup.fill" : "hand.thumbsup"
                            )
                        }
                        Button {
                            onFeedback("negative")
                        } label: {
                            Label(
                                feedbackKind == "negative" ? "Remove Not Helpful" : "Not Helpful",
                                systemImage: feedbackKind == "negative" ? "hand.thumbsdown.fill" : "hand.thumbsdown"
                            )
                        }
                    }
                }

                detailIcon()
            }

            // Under the bubble, not inside it — same placement as
            // `EventBubbleView.assistantBubble`.
            if !attachments.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    MessageAttachmentsView(
                        attachments: attachments,
                        onTapImage: { fullscreenAttachment = $0 }
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 4)
            }

            HStack(spacing: 6) {
                if let modelName = modelDisplayName {
                    Text(modelName)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let feedbackKind {
                    Image(systemName: feedbackKind == "positive" ? "hand.thumbsup.fill" : "hand.thumbsdown.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(feedbackKind == "positive" ? Color.amux.sage : Color.amux.cinnabarDeep)
                        .accessibilityLabel(feedbackKind == "positive" ? "Marked helpful" : "Marked not helpful")
                }
            }
            .padding(.leading, 18)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .fullScreenCover(item: $fullscreenAttachment) { item in
            FullScreenAttachmentViewer(attachment: item)
        }
    }
}

// MARK: - ThinkingBlockView
//
// Hai-language thinking row: mono uppercase eyebrow + slate inline preview.
// Expanded body sits behind a hairline left-rule indent, no card chrome,
// matching the wabi-sabi "spare the vermillion + trace of the hand" rules
// in `apps/ios/DESIGN.md`.

struct ThinkingBlockView: View {
    let text: String
    @State private var isExpanded = false

    private var collapsedText: String {
        text
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedPreview: String {
        let collapsed = collapsedText
        guard collapsed.count > 80 else { return collapsed }
        return String(collapsed.prefix(80)) + "…"
    }

    /// Expanding earns a chevron only when it reveals something the preview
    /// doesn't already show — a short thought is the whole row.
    private var isExpandable: Bool {
        collapsedText.count > 80 || text.contains("\n")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                if isExpandable { withAnimation(.easeInOut(duration: 0.2)) { isExpanded.toggle() } }
            } label: {
                HStack(spacing: 8) {
                    Text("THINKING")
                        .font(.system(size: 9, design: .monospaced))
                        .tracking(2)
                        .foregroundStyle(Color.amux.slate)
                        .layoutPriority(1)
                    if !isExpanded, !trimmedPreview.isEmpty {
                        // Basalt, not slate: the thought is the row's content
                        // and the eyebrow is only its label. Setting both in
                        // slate flattened the page into one undifferentiated
                        // grey.
                        Text(trimmedPreview)
                            .font(.caption2)
                            .foregroundStyle(Color.amux.basalt)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 0)
                    if isExpandable {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .medium))
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .foregroundStyle(Color.amux.slate.opacity(0.6))
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!isExpandable)

            if isExpanded {
                HStack(alignment: .top, spacing: 12) {
                    Rectangle()
                        .fill(Color.amux.hairline)
                        .frame(width: 0.5)
                    Text(text)
                        .font(.caption)
                        .foregroundStyle(Color.amux.basalt)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }
}

// MARK: - ErrorBlockView

struct ErrorBlockView: View {
    let message: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Color.amux.cinnabarDeep)
            Text(message)
                .font(.caption)
                .foregroundStyle(Color.amux.cinnabarDeep)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .liquidGlass(in: RoundedRectangle(cornerRadius: 12),
                     tint: Color.amux.cinnabarDeep,
                     interactive: false)
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .contextMenu {
            MessageContextMenu(text: message)
        }
    }
}

// MARK: - TypingIndicatorView

struct TypingIndicatorView: View {
    @State private var phase = 0.0

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3) { i in
                Circle()
                    .fill(Color.amux.slate)
                    .frame(width: 8, height: 8)
                    .scaleEffect(dotScale(for: i))
                    .opacity(dotOpacity(for: i))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .liquidGlass(in: RoundedRectangle(cornerRadius: 18), interactive: false)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .onAppear {
            withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                phase = 1
            }
        }
    }

    private func dotScale(for index: Int) -> Double {
        let offset = Double(index) * 0.15
        let value = sin((phase + offset) * .pi)
        return 0.6 + 0.4 * value
    }

    private func dotOpacity(for index: Int) -> Double {
        let offset = Double(index) * 0.15
        let value = sin((phase + offset) * .pi)
        return 0.4 + 0.6 * value
    }
}

// MARK: - FullscreenImageContext

private struct FullscreenImageContext: Identifiable {
    let id = UUID()
    let initialURL: URL
    let sessionID: String
}

// MARK: - FullScreenSessionImageViewer

/// Full-screen paging image viewer for all attachment images in a session.
/// Queries every OutboxMessage for `sessionID`, flattens their attachment URLs
/// in chronological order, and presents them in a paging TabView so the user
/// can swipe left/right between images. Opens at the tapped image's index.
/// Internal, not private: `StreamingDetailView` opens the same viewer for
/// the files it lists at the end of a turn.
struct FullScreenSessionImageViewer: View {
    @Environment(\.dismiss) private var dismiss
    let sessionID: String
    let initialURL: URL

    @Query private var messages: [OutboxMessage]
    @State private var currentIndex: Int = 0

    init(sessionID: String, initialURL: URL) {
        self.sessionID = sessionID
        self.initialURL = initialURL
        let sid = sessionID
        _messages = Query(
            filter: #Predicate<OutboxMessage> { $0.sessionID == sid },
            sort: \.createdAt
        )
    }

    /// Every image the viewer can page through, plus the one actually
    /// tapped. The query source is the local outbox — only what this device
    /// sent — so an agent's attachment is never in it. Without the union a
    /// tap on one opened the viewer on an unrelated image, because
    /// `seekToInitial` found no index and left it at 0.
    private var allURLs: [URL] {
        let sent = messages.flatMap { $0.attachmentURLs }
        return sent.contains(initialURL) ? sent : sent + [initialURL]
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()

            if allURLs.isEmpty {
                AsyncImage(url: initialURL) { phase in
                    imagePhaseView(phase)
                }
                .padding()
            } else {
                TabView(selection: $currentIndex) {
                    ForEach(Array(allURLs.enumerated()), id: \.offset) { idx, url in
                        AsyncImage(url: url) { phase in
                            imagePhaseView(phase)
                        }
                        .tag(idx)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: allURLs.count > 1 ? .always : .never))
                .ignoresSafeArea()
            }

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, Color.black.opacity(0.5))
            }
            .buttonStyle(.plain)
            .padding(.top, 56)
            .padding(.trailing, 20)
        }
        .onAppear { seekToInitial() }
        .onChange(of: allURLs) { _, _ in seekToInitial() }
    }

    @ViewBuilder
    private func imagePhaseView(_ phase: AsyncImagePhase) -> some View {
        switch phase {
        case .success(let image):
            image.resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failure:
            VStack(spacing: 12) {
                Image(systemName: "photo.badge.exclamationmark")
                    .font(.system(size: 48))
                    .foregroundStyle(.secondary)
                Text("Failed to load")
                    .foregroundStyle(.secondary)
            }
        default:
            ProgressView()
                .tint(.white)
        }
    }

    private func seekToInitial() {
        guard let idx = allURLs.firstIndex(of: initialURL) else { return }
        currentIndex = idx
    }
}

// MARK: - OutboxStatusDot

/// Tiny accessory rendered to the right of a self-authored user_prompt
/// bubble showing the OutboxMessage row's lifecycle state. Reads via a
/// targeted `@Query` filtered by `messageID` so updates to a single row
/// do not invalidate the whole bubble list. Tap on `.failed` calls back
/// into the parent's `OutboxSender.retry` handler.
struct OutboxStatusDot: View {
    let outboxMessageID: String
    let onRetry: ((String) -> Void)?

    @Query private var rows: [OutboxMessage]

    init(outboxMessageID: String, onRetry: ((String) -> Void)?) {
        self.outboxMessageID = outboxMessageID
        self.onRetry = onRetry
        let id = outboxMessageID
        _rows = Query(filter: #Predicate<OutboxMessage> { $0.messageID == id })
    }

    private var state: OutboxState? { rows.first?.state }

    var body: some View {
        Group {
            switch state {
            case .pending, .inFlight:
                Image(systemName: "circle.dashed")
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(Color.amux.basalt)
                    .accessibilityLabel("Sending")
            case .delivered:
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .regular))
                    .foregroundStyle(Color.amux.basalt.opacity(0.5))
                    .accessibilityLabel("Delivered")
            case .failed:
                Button {
                    onRetry?(outboxMessageID)
                } label: {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 12, weight: .regular))
                        .foregroundStyle(Color.amux.cinnabarDeep)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Retry sending message")
            case nil:
                EmptyView()
            }
        }
        .padding(.bottom, 6)
    }
}

// MARK: - SentAttachmentsView

/// Renders attachment images for a locally-sent user_prompt bubble.
/// Queries the `OutboxMessage` row via `outboxMessageID` so the images
/// surface as soon as the upload completes, without needing a full
/// AgentEvent schema migration. Only fires for messages sent from this
/// device (outboxMessageID is nil for remote messages).
private struct SentAttachmentsView: View {
    @Query private var rows: [OutboxMessage]
    let onTap: ((URL, String) -> Void)?

    init(outboxMessageID: String, onTap: ((URL, String) -> Void)? = nil) {
        let id = outboxMessageID
        _rows = Query(filter: #Predicate<OutboxMessage> { $0.messageID == id })
        self.onTap = onTap
    }

    private var attachmentURLs: [URL] { rows.first?.attachmentURLs ?? [] }
    private var sessionID: String { rows.first?.sessionID ?? "" }

    var body: some View {
        ForEach(Array(attachmentURLs.enumerated()), id: \.offset) { _, url in
            if ParsedMessageContent.imageExtensions.contains(url.pathExtension.lowercased()) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFit()
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    default:
                        RoundedRectangle(cornerRadius: 12)
                            .fill(Color.amux.pebble)
                            .frame(height: 150)
                    }
                }
                .onTapGesture { onTap?(url, sessionID) }
            } else {
                // Non-image uploads used to render through the AsyncImage
                // failure branch — a bare grey block with the filename
                // gone. A file card keeps the name, type, and a way to
                // open it.
                AttachmentFileCard(url: url)
            }
        }
    }
}

// MARK: - MessageAttachmentsView

/// Files a message carries structurally, from `messages.attachments`.
///
/// Distinct from `SentAttachmentsView`, which reads this device's local
/// outbox row: that one only knows about what *this* device sent, while
/// these ride on the message itself and so survive a reinstall and show up
/// on every device — including an agent's own attachments.
struct MessageAttachmentsView: View {
    let attachments: [MessageAttachment]
    let onTapImage: ((MessageAttachment) -> Void)?

    var body: some View {
        ForEach(attachments, id: \.identity) { item in
            if item.isImage {
                AttachmentImageView(attachment: item, maxHeight: 220)
                    .onTapGesture { onTapImage?(item) }
                    .accessibilityLabel(item.filename)
            } else {
                AttachmentFileCard(attachment: item)
            }
        }
    }
}

// MARK: - AttachmentImageView

/// A message attachment rendered as an image.
///
/// Not `AsyncImage`: the bytes come from a caller-scoped Cloud API route, so
/// they need the user's bearer (see `AttachmentContentLoader`). A failure
/// falls back to the file card rather than an empty frame — a blank space is
/// indistinguishable from "no image".
struct AttachmentImageView: View {
    let attachment: MessageAttachment
    var maxHeight: CGFloat = 220

    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: maxHeight)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            } else if failed {
                AttachmentFileCard(attachment: attachment)
            } else {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.amux.pebble)
                    .overlay(ProgressView())
                    .frame(height: 150)
            }
        }
        .task(id: attachment.identity) { await load() }
    }

    private func load() async {
        guard image == nil, !failed, let path = attachment.bucketPath else {
            if attachment.bucketPath == nil { failed = true }
            return
        }
        do {
            let data = try await AttachmentContentLoader.shared.data(
                bucketPath: path, fileName: attachment.filename
            )
            guard let decoded = UIImage(data: data) else { failed = true; return }
            image = decoded
        } catch {
            failed = true
        }
    }
}

private extension Optional where Wrapped == String {
    var isNilOrEmpty: Bool { self?.isEmpty != false }
}

// MARK: - MessageContentParser

private struct ParsedMessageContent {
    let text: String
    let imageURLs: [URL]
    /// Non-image attachment links (whole-line URLs pointing at uploaded
    /// files). Rendered as file cards instead of raw URLs or grey blocks.
    let fileURLs: [URL]
    static let imageExtensions: Set<String> = ["jpg", "jpeg", "png", "gif", "webp", "heic", "bmp"]
    /// Whole-line URLs with these extensions read as shared files. Kept
    /// conservative so ordinary links pasted into prose stay links.
    static let fileExtensions: Set<String> = [
        "pdf", "zip", "txt", "md", "csv", "json", "log",
        "doc", "docx", "xls", "xlsx", "ppt", "pptx", "key", "pages", "numbers",
        "mp3", "wav", "m4a", "mp4", "mov",
    ]

    static func parse(_ raw: String) -> ParsedMessageContent {
        let lines = raw.components(separatedBy: "\n")
        var imageURLs: [URL] = []
        var fileURLs: [URL] = []
        var textLines: [String] = []
        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let url = URL(string: trimmed),
               url.scheme?.hasPrefix("http") == true,
               !url.host.isNilOrEmpty {
                let ext = url.pathExtension.lowercased()
                if imageExtensions.contains(ext) {
                    imageURLs.append(url)
                    continue
                }
                // Attachment-bucket links count as files even without a
                // recognized extension — that's where uploads live.
                if fileExtensions.contains(ext) || url.path.contains("/attachments/") {
                    fileURLs.append(url)
                    continue
                }
                textLines.append(line)
            } else {
                textLines.append(line)
            }
        }
        let text = textLines.joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return ParsedMessageContent(text: text, imageURLs: imageURLs, fileURLs: fileURLs)
    }
}

// MARK: - ReplyQuoteChip

/// Compact quote of the message a bubble replies to: sender name + first
/// line, with the Hai hairline rail. Tapping jumps to the quoted message
/// when it is still in the feed.
struct ReplyQuoteChip: View {
    let quote: SessionDetailViewModel.ReplyQuote
    let actorMap: CachedActorMap
    let alignment: HorizontalAlignment
    let onTap: (() -> Void)?

    private var senderName: String {
        guard !quote.senderActorID.isEmpty else { return "" }
        return actorMap.displayName(for: quote.senderActorID) ?? String(quote.senderActorID.prefix(8))
    }

    private var snippet: String {
        let firstLine = quote.content
            .split(separator: "\n", omittingEmptySubsequences: true)
            .first.map(String.init) ?? ""
        let trimmed = firstLine.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? String(localized: "Message unavailable") : trimmed
    }

    var body: some View {
        Button {
            onTap?()
        } label: {
            HStack(spacing: 8) {
                Rectangle()
                    .fill(Color.amux.cinnabar.opacity(0.6))
                    .frame(width: 2)
                VStack(alignment: .leading, spacing: 1) {
                    if !senderName.isEmpty {
                        Text(senderName)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Color.amux.basalt)
                            .lineLimit(1)
                    }
                    Text(snippet)
                        .font(.caption2)
                        .foregroundStyle(Color.amux.slate)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color.amux.pebble.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(onTap == nil)
        .accessibilityLabel("In reply to \(senderName)")
    }
}

// MARK: - AttachmentFileCard

/// A non-image attachment in a message bubble: type icon + filename +
/// extension badge. Tapping opens it in-app (`AttachmentPreviewSheet`)
/// rather than handing the URL to Safari — an agent that produces an HTML
/// report should not bounce the reader out of the conversation to read it.
struct AttachmentFileCard: View {
    /// A file the message carries, fetched by bucket path.
    private let attachment: MessageAttachment?
    /// A bare link found in the message body — all the older path gives us.
    private let linkURL: URL?
    private let overrideName: String?

    @State private var isPreviewing = false

    init(attachment: MessageAttachment) {
        self.attachment = attachment
        self.linkURL = nil
        self.overrideName = nil
    }

    init(url: URL, displayName: String? = nil) {
        self.attachment = nil
        self.linkURL = url
        self.overrideName = displayName
    }

    private var filename: String {
        if let attachment, !attachment.filename.isEmpty { return attachment.filename }
        if let overrideName, !overrideName.isEmpty { return overrideName }
        guard let linkURL else { return "" }
        let name = linkURL.lastPathComponent.removingPercentEncoding ?? linkURL.lastPathComponent
        return name.isEmpty ? linkURL.absoluteString : name
    }

    /// Taken from the name rather than the URL: an attachment path can end in
    /// an id with no extension at all.
    private var ext: String {
        let fromName = (filename as NSString).pathExtension
        if !fromName.isEmpty { return fromName.lowercased() }
        return (linkURL?.pathExtension ?? "").lowercased()
    }

    private var source: AttachmentSource? {
        if let attachment { return .managed(attachment) }
        if let linkURL { return .link(linkURL, name: filename) }
        return nil
    }

    private var iconName: String {
        switch ext {
        case "pdf": return "doc.richtext"
        case "zip": return "doc.zipper"
        case "csv", "xls", "xlsx", "numbers": return "tablecells"
        case "doc", "docx", "pages", "txt", "md", "log", "json": return "doc.text"
        case "html", "htm": return "globe"
        case "ppt", "pptx", "key": return "rectangle.on.rectangle"
        case "mp3", "wav", "m4a": return "waveform"
        case "mp4", "mov": return "film"
        default: return "doc"
        }
    }

    var body: some View {
        Button {
            isPreviewing = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: iconName)
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(Color.amux.basalt)
                    .frame(width: 34, height: 34)
                    .background(Color.amux.pebble, in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 1) {
                    Text(filename)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.amux.onyx)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if !ext.isEmpty {
                        Text(ext.uppercased())
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(Color.amux.slate)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(8)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Color.amux.hairline, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $isPreviewing) {
            if let source {
                AttachmentPreviewSheet(source: source)
            }
        }
        .contextMenu {
            if let linkURL {
                Button {
                    UIPasteboard.general.string = linkURL.absoluteString
                } label: {
                    Label("Copy Link", systemImage: "doc.on.doc")
                }
                Button {
                    UIApplication.shared.open(linkURL)
                } label: {
                    Label("Open in another app", systemImage: "arrow.up.forward.app")
                }
                ShareLink(item: linkURL) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
            }
        }
    }
}

// MARK: - MessageContextMenu

struct MessageContextMenu: View {
    let text: String

    var body: some View {
        Button {
            UIPasteboard.general.string = text
        } label: {
            Label("Copy", systemImage: "doc.on.doc")
        }

        if let url = URL(string: text), UIApplication.shared.canOpenURL(url) {
            Button {
                UIApplication.shared.open(url)
            } label: {
                Label("Open Link", systemImage: "safari")
            }
        }

        ShareLink(item: text) {
            Label("Share", systemImage: "square.and.arrow.up")
        }
    }
}
