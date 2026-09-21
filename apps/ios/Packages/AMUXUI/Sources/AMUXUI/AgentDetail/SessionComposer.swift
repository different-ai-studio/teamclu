import SwiftUI
import AMUXCore
import AMUXSharedUI

struct SessionComposer: View {
    @Binding var promptText: String
    @Binding var attachments: [URL]

    let voiceRecorder: VoiceRecorder
    let availableCommands: [SlashCommand]
    let availableMentions: [MentionTarget]
    /// Resolved session id (from `SessionDetailViewModel.session?.sessionId`)
    /// or empty when the composer is hosted by the legacy runtime-only path.
    /// Empty disables uploads — the picker still lets the user attach files
    /// locally, but no Supabase Storage upload is triggered.
    let sessionID: String
    let teamID: String

    /// Ordered list of session agents. Used only as the source of truth for
    /// the order in which selected display names appear on the Row-2 `[@]`
    /// button label; the chip-bar itself is no longer rendered inline.
    let agentChips: [AgentChipBar.AgentChip]
    @Binding var agentChipSelection: Set<String>
    let streamingAgentIDs: Set<String>
    let onAgentInterrupt: (String) -> Void

    /// Full agent list for the AgentsSheet (the modal opened by the [@] button).
    let memberSheetAgents: [MemberSheetAgent]
    /// Resolves the live attachment for a given agent; nil when that agent is
    /// cold for this session. Kept as a closure so the composer doesn't hold a
    /// SwiftData query.
    let attachmentForAgent: (MemberSheetAgent) -> AgentAttachment?
    /// Called when the user selects a different model for an agent in AgentsSheet.
    let onApplyModelForAgent: (MemberSheetAgent, String) -> Void

    let onSend: ([URL]) -> Void
    let onAgentMention: (MentionTarget) -> Void

    /// Owned by the host, not by this view. The field sits in the detail
    /// view's bottom `safeAreaInset` — outside the transcript's ScrollView —
    /// so `.scrollDismissesKeyboard` can't reach its focus. Hoisting the
    /// state lets the transcript drop the keyboard on scroll and on tap.
    @FocusState.Binding var inputFocused: Bool

    @State private var showDrawer = false
    @State private var showAgentsSheet = false
    @State private var slashCandidates: [SlashCommand] = []
    @State private var hasPendingSlashCommand = false
    @State private var mentionCandidates: [MentionTarget] = []
    @State private var uploadingAttachments: [String: AttachmentUpload] = [:]
    /// Lazily created on first sheet present; nil before the modelContext is
    /// available or when the SupabaseProjectConfiguration lookup fails (in
    /// which case the drawer falls back to no-op upload behavior).
    @State private var uploadManager: AttachmentUploadManager?
    @Environment(\.modelContext) private var modelContext

    private var hasText: Bool {
        !promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var rightButton: ComposerRightButton {
        ComposerState.rightButton(
            hasText: hasText,
            voiceState: voiceRecorder.state
        )
    }

    private var inputMode: ComposerInputMode {
        ComposerState.inputMode(voiceState: voiceRecorder.state)
    }

    private var slashPrefix: String? {
        guard let first = promptText.first, first == "/" else { return nil }
        let rest = promptText.dropFirst()
        guard rest.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }) else {
            return nil
        }
        return String(rest)
    }

    private var matchesKnownCommand: Bool {
        guard promptText.hasPrefix("/") else { return false }
        let after = promptText.dropFirst()
        let head = after.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? String(after)
        guard !head.isEmpty else { return false }
        return availableCommands.contains(where: { $0.name == head })
    }

    /// Active `@<query>` token at the end of `promptText`, if any. Returns
    /// the substring after the trailing `@` (possibly empty), or nil if no
    /// in-progress mention is being typed. Anchored to end-of-string so the
    /// popup auto-closes once the user types whitespace or moves on.
    private var mentionQuery: String? {
        guard !promptText.isEmpty else { return nil }
        // Walk back from the end collecting word-token characters until we
        // hit either an `@` (mention starts) or anything else (no mention).
        var query = ""
        for ch in promptText.reversed() {
            if ch == "@" {
                let beforeIndex = promptText.index(promptText.endIndex, offsetBy: -(query.count + 1))
                if beforeIndex == promptText.startIndex { return query }
                let prev = promptText[promptText.index(before: beforeIndex)]
                if prev.isWhitespace || prev.isPunctuation || prev.isNewline { return query }
                return nil
            }
            if ch.isLetter || ch.isNumber || ch == "_" || ch == "-" || ch == "." {
                query.insert(ch, at: query.startIndex)
                continue
            }
            return nil
        }
        return nil
    }

    var body: some View {
        VStack(spacing: 6) {
            if !slashCandidates.isEmpty {
                SlashCommandsPopup(
                    candidates: slashCandidates,
                    onTap: { cmd in
                        promptText = "/\(cmd.name) "
                        slashCandidates = []
                        hasPendingSlashCommand = true
                    }
                )
                .padding(.horizontal, 16)
                .animation(AMUXAnimation.fast, value: slashCandidates)
            }
            if !mentionCandidates.isEmpty {
                MentionsPopup(
                    candidates: mentionCandidates,
                    onTap: { target in pickMention(target) }
                )
                .padding(.horizontal, 16)
                .animation(AMUXAnimation.fast, value: mentionCandidates)
            }

            // Attachment thumbnails pre-send tray (agent chips have moved
            // into the Row-2 agent button label — no longer shown here).
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(attachments, id: \.self) { url in
                            AttachmentThumbnailTile(
                                url: url,
                                upload: uploadingAttachments[url.absoluteString],
                                onRemove: { discardAttachment(url) }
                            )
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 4)
                }
            }

            twoRowComposer
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
        }
        .onChange(of: promptText) { _, _ in
            recomputeSlashCandidates()
            recomputeMentionCandidates()
        }
        .onChange(of: availableCommands) { _, _ in recomputeSlashCandidates() }
        .onChange(of: availableMentions) { _, _ in recomputeMentionCandidates() }
        .onChange(of: voiceRecorder.state) { _, newState in
            if newState == .done {
                let text = voiceRecorder.transcribedText ?? ""
                if !text.isEmpty {
                    promptText = text
                }
                voiceRecorder.reset()
            }
        }
        .sheet(isPresented: $showDrawer) {
            AttachmentDrawerSheet(
                attachments: $attachments,
                uploadManager: ensureUploadManager(),
                sessionID: sessionID,
                teamID: teamID,
                onUploadStarted: { key, upload in
                    // The drawer appends to the tray first and starts the
                    // upload after an await, so the tile can be removed
                    // before this lands. Dropping a record for a URL that is
                    // no longer in the tray keeps removal authoritative.
                    guard attachments.contains(where: { $0.absoluteString == key }) else { return }
                    uploadingAttachments[key] = upload
                }
            )
            .presentationDetents([.fraction(0.4), .medium])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showAgentsSheet) {
            AgentsSheet(
                agents: memberSheetAgents,
                selection: $agentChipSelection,
                streamingAgentIDs: streamingAgentIDs,
                attachmentForAgent: attachmentForAgent,
                onApplyModel: onApplyModelForAgent,
                onInterrupt: { agent in
                    onAgentInterrupt(agent.id)
                }
            )
        }
    }

    // MARK: - Two-row capsule

    private static let composerCornerRadius: CGFloat = 18
    private static let composerInputFontSize: CGFloat = 15
    private static let composerAgentLabelFontSize: CGFloat = 14
    private static let composerAgentIconFontSize: CGFloat = 16

    /// The LiquidGlass composer containing:
    ///   Row 1 — text field (or waveform when recording)
    ///   Row 2 — [+] attachment · [@ …] agent button · Spacer · right-button
    @ViewBuilder
    private var twoRowComposer: some View {
        VStack(spacing: 0) {
            // Row 1: input area
            Group {
                switch inputMode {
                case .textField:
                    TextField("Send a message…", text: $promptText, axis: .vertical)
                        .font(.system(size: Self.composerInputFontSize))
                        .lineLimit(2...6)
                        .focused($inputFocused)
                        .submitLabel(.return)
                        .accessibilityIdentifier("composer.textField")
                case .waveform:
                    RecordingWaveform(level: voiceRecorder.audioLevel)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.horizontal, 14)
            .padding(.top, 10)
            .padding(.bottom, 4)

            // Divider between rows
            Divider()
                .padding(.horizontal, 10)

            // Row 2: [+] attachment · [@ agent] + Spacer + right-button
            HStack(spacing: 8) {
                Button { showDrawer = true } label: {
                    Image(systemName: "plus")
                        .font(.body)
                        .frame(width: 32, height: 32)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("composer.plusButton")

                agentButton
                Spacer()
                rightButtonView
                    .padding(.trailing, 4)
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 8)
        }
        .liquidGlass(in: RoundedRectangle(cornerRadius: Self.composerCornerRadius, style: .continuous))
    }

    /// The agent selection button. Shows "@ name ×N" when agents are selected,
    /// or just "@ " icon-only when none are selected.
    @ViewBuilder
    private var agentButton: some View {
        Button { showAgentsSheet = true } label: {
            HStack(spacing: 4) {
                Image(systemName: "at")
                    .font(.system(size: Self.composerAgentIconFontSize))
                if let labelText = agentButtonLabelText {
                    Text(labelText)
                        .font(.system(size: Self.composerAgentLabelFontSize, weight: .medium))
                        .lineLimit(1)
                }
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 8)
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("composer.agentButton")
        .accessibilityLabel("Agents, \(agentChipSelection.count) selected")
    }

    /// Text shown after the `@` glyph in the agent button. Nil → icon only.
    private var agentButtonLabelText: String? {
        AgentButtonLabel.text(selectedDisplayNamesInOrder: orderedSelectedAgentDisplayNames())
    }

    /// Returns display names of selected agents in a stable order
    /// (preserving the order they appear in `agentChips`).
    private func orderedSelectedAgentDisplayNames() -> [String] {
        agentChips
            .filter { agentChipSelection.contains($0.id) }
            .map { $0.displayName }
    }

    @ViewBuilder
    private var rightButtonView: some View {
        switch rightButton {
        case .stopRecording:
            Button {
                voiceRecorder.stopRecording()
            } label: {
                Image(systemName: "mic.fill")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Color.amux.cinnabarDeep)
                    .frame(width: 32, height: 32)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("composer.stopRecordingButton")

        case .send:
            let hasFailedAttachments = uploadingAttachments.values.contains { $0.uploadState == .failed }
            let hasUploadingAttachments = uploadingAttachments.values.contains { $0.uploadState == .uploading }

            Button {
                if !hasUploadingAttachments {
                    let storageURLs = uploadingAttachments.values
                        .compactMap { $0.storageURL }
                        .compactMap { URL(string: $0) }
                    // Drop focus before handing the text off: the keyboard
                    // goes away and the IME commits any marked text, so the
                    // host's `promptText = ""` empties the field for real.
                    inputFocused = false
                    onSend(storageURLs)
                    hasPendingSlashCommand = false
                    // The host clears the `attachments` tray; these are the
                    // matching upload records. Without this they ride along
                    // as storage URLs on the *next* message too.
                    uploadingAttachments = [:]
                }
            } label: {
                Image(systemName: "arrow.up")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(
                        hasUploadingAttachments || hasFailedAttachments
                            ? Color.amux.mist
                            : Color.amux.onyx
                    )
                    .frame(width: 32, height: 32)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(hasUploadingAttachments)
            .modifier(SendButtonGlassModifier(
                emphasized: hasPendingSlashCommand && !hasUploadingAttachments
            ))
            .accessibilityIdentifier("composer.sendButton")

        case .mic:
            Button {
                voiceRecorder.startRecording()
            } label: {
                Image(systemName: "mic")
                    .font(.body)
                    .foregroundStyle(.primary)
                    .frame(width: 32, height: 32)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("composer.micButton")
        }
    }

    /// Returns a cached AttachmentUploadManager, building one on first call
    /// from `Bundle.main`'s Supabase config. Returns nil when sessionID is
    /// empty (legacy runtime-only flow has no session to upload against) or
    /// when the Supabase config can't be resolved — drawer falls back to
    /// no-op upload behavior in either case.
    private func ensureUploadManager() -> AttachmentUploadManager? {
        guard !sessionID.isEmpty else { return nil }
        if let existing = uploadManager { return existing }
        guard let mgr = try? AttachmentUploadManager.fromMainBundle(modelContext: modelContext) else {
            return nil
        }
        uploadManager = mgr
        return mgr
    }

    /// Forget an attachment the user pulled out of the tray. The tray binding
    /// is only half of it: the send button builds its storage URLs from
    /// `uploadingAttachments`, so a record left behind re-attaches a file that
    /// was explicitly removed. Deleting the row also aborts an upload still in
    /// flight — `performUpload` re-fetches by id at each step and bails once
    /// the row is gone, before the bytes reach the network.
    private func discardAttachment(_ url: URL) {
        attachments.removeAll { $0 == url }
        guard let upload = uploadingAttachments.removeValue(forKey: url.absoluteString) else { return }
        modelContext.delete(upload)
        try? modelContext.save()
    }

    private func recomputeSlashCandidates() {
        if let prefix = slashPrefix {
            let lower = prefix.lowercased()
            slashCandidates = Array(
                availableCommands
                    .filter { $0.name.lowercased().hasPrefix(lower) }
                    .prefix(5)
            )
        } else {
            slashCandidates = []
        }
        hasPendingSlashCommand = matchesKnownCommand
    }

    private func recomputeMentionCandidates() {
        guard let query = mentionQuery else {
            mentionCandidates = []
            return
        }
        mentionCandidates = Array(
            MentionCandidateFilter.filter(
                all: availableMentions,
                query: query,
                selectedAgentIDs: agentChipSelection
            )
            .prefix(5)
        )
    }

    private func pickMention(_ target: MentionTarget) {
        guard let query = mentionQuery else { return }
        let dropCount = query.count + 1   // +1 for the `@`
        let head = String(promptText.dropLast(dropCount))
        switch target.kind {
        case .member:
            // Inline body token — survives in the message text and visible
            // to the human collaborator's eyes while typing.
            promptText = head + "@\(target.displayName) "
        case .agent:
            // Drop the `@<query>` trigger from the visible input. The chip
            // card above the composer is the in-flight routing indicator;
            // the body text is auto-prepended with `@<displayName> ` at
            // send time (composeBodyWithMentions in the viewmodel) so the
            // sent bubble preserves the mention without cluttering the
            // typing surface.
            promptText = head
            onAgentMention(target)
        }
        mentionCandidates = []
    }
}

private struct AttachmentThumbnailTile: View {
    let url: URL
    let upload: AttachmentUpload?
    let onRemove: () -> Void

    private static let imageExts: Set<String> = [
        "jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "bmp", "tiff"
    ]

    @State private var thumbnail: UIImage?

    private var isImage: Bool {
        Self.imageExts.contains(url.pathExtension.lowercased())
    }

    private var uploadState: UploadState? { upload?.uploadState }
    private var progress: Double { upload?.progress ?? 0 }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            tileBody
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color.primary.opacity(0.06), lineWidth: 0.5)
                )
                .overlay(progressOverlay)

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, Color.black.opacity(0.55))
            }
            .buttonStyle(.plain)
            .offset(x: 4, y: -4)
            .accessibilityLabel("Remove attachment")
        }
        .task(id: url) {
            guard isImage, thumbnail == nil else { return }
            thumbnail = await loadThumbnail(from: url)
        }
    }

    @ViewBuilder
    private var tileBody: some View {
        if isImage, let image = thumbnail {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
        } else {
            ZStack {
                Color.secondary.opacity(0.12)
                VStack(spacing: 2) {
                    Image(systemName: isImage ? "photo" : "doc")
                        .font(.system(size: 18, weight: .regular))
                        .foregroundStyle(.secondary)
                    let ext = url.pathExtension.uppercased()
                    if !ext.isEmpty {
                        Text(ext)
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var progressOverlay: some View {
        switch uploadState {
        case .uploading, .pending:
            ZStack {
                Color.black.opacity(0.35)
                ProgressView(value: progress)
                    .progressViewStyle(.linear)
                    .tint(.white)
                    .frame(width: 40)
            }
        case .failed:
            ZStack {
                Color.black.opacity(0.45)
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.red)
            }
        case .completed, .none:
            EmptyView()
        }
    }

    private func loadThumbnail(from url: URL) async -> UIImage? {
        await Task.detached(priority: .utility) {
            guard let data = try? Data(contentsOf: url),
                  let image = UIImage(data: data) else { return nil }
            let target: CGFloat = 168 // 56pt * ~3x for retina
            let size = image.size
            let scale = max(target / size.width, target / size.height)
            let newSize = CGSize(width: size.width * scale, height: size.height * scale)
            let renderer = UIGraphicsImageRenderer(size: newSize)
            return renderer.image { _ in
                image.draw(in: CGRect(origin: .zero, size: newSize))
            }
        }.value
    }
}

private struct SendButtonGlassModifier: ViewModifier {
    let emphasized: Bool
    func body(content: Content) -> some View {
        if emphasized {
            content.liquidGlass(in: Circle(), tint: .accentColor)
        } else {
            content.liquidGlass(in: Circle())
        }
    }
}
