import SwiftUI
import SwiftData
import PhotosUI
import AMUXCore
import AMUXSharedUI

public struct IdeaDetailView: View {
    let ideaID: String
    @Bindable var ideaStore: IdeaStore
    let sessionViewModel: SessionListViewModel
    let teamcluService: TeamcluService?
    let mqtt: MQTTService
    let hub: MQTTMessageHub
    let peerId: String
    let sessionsRepository: (any SessionRepository)?
    let connectedAgentsStore: ConnectedAgentsStore?
    /// Forwarded to NewSessionSheet's member picker so it refreshes presence.
    let actorStore: ActorStore?
    let agentPresenceStore: AgentPresenceStore?
    @Binding var navigationPath: [String]

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Query(sort: \CachedActor.displayName) private var allActors: [CachedActor]
    @Query(sort: \Session.lastMessageAt, order: .reverse)
    private var allSessions: [Session]
    @Query(sort: \Workspace.displayName) private var workspaces: [Workspace]

    @State private var localTitle: String = ""
    @State private var localDescription: String = ""
    @State private var showNewSession = false
    @State private var showArchiveConfirm = false
    @State private var isArchiving = false
    @State private var isSubmittingProgress = false
    @State private var didSeedLocals = false
    @State private var composerText: String = ""
    @State private var progressImageAttachments: [URL] = []
    @State private var progressImageUploads: [String: AttachmentUpload] = [:]
    @State private var progressPhotoItems: [PhotosPickerItem] = []
    @State private var showProgressCamera = false
    @State private var showProgressPhotoPicker = false
    @State private var showProgressImageSourceDialog = false
    @State private var progressUploadManager: AttachmentUploadManager?
    @FocusState private var titleFocused: Bool
    @FocusState private var descriptionFocused: Bool

    public init(
        ideaID: String,
        ideaStore: IdeaStore,
        sessionViewModel: SessionListViewModel,
        teamcluService: TeamcluService?,
        mqtt: MQTTService,
        hub: MQTTMessageHub,
        peerId: String,
        sessionsRepository: (any SessionRepository)? = nil,
        connectedAgentsStore: ConnectedAgentsStore? = nil,
        actorStore: ActorStore? = nil,
        agentPresenceStore: AgentPresenceStore? = nil,
        navigationPath: Binding<[String]>
    ) {
        self.ideaID = ideaID
        self.ideaStore = ideaStore
        self.sessionViewModel = sessionViewModel
        self.teamcluService = teamcluService
        self.mqtt = mqtt
        self.hub = hub
        self.peerId = peerId
        self.sessionsRepository = sessionsRepository
        self.connectedAgentsStore = connectedAgentsStore
        self.actorStore = actorStore
        self.agentPresenceStore = agentPresenceStore
        self._navigationPath = navigationPath
    }

    private var item: IdeaRecord? { ideaStore.idea(id: ideaID) }

    private var creator: CachedActor? {
        guard let item, !item.createdByActorID.isEmpty else { return nil }
        return allActors.first { $0.actorId == item.createdByActorID }
    }

    private var workspaceName: String? {
        guard let item, !item.workspaceID.isEmpty else { return nil }
        return workspaces.first { $0.workspaceId == item.workspaceID }?.displayName
    }

    private var relatedSessions: [Session] {
        allSessions.filter { $0.ideaId == ideaID }
    }

    private var activities: [IdeaActivityRecord] {
        ideaStore.activities(for: ideaID)
    }

    public var body: some View {
        Group {
            if let item {
                content(for: item)
            } else {
                ContentUnavailableView("Idea Not Found", systemImage: IdeaUIPresentation.systemImage)
            }
        }
        .onAppear { seedLocals() }
        .onChange(of: ideaID) { _, _ in didSeedLocals = false; seedLocals() }
        .task(id: ideaID) {
            await ideaStore.reloadActivities(ideaID: ideaID)
        }
    }

    @ViewBuilder
    private func content(for item: IdeaRecord) -> some View {
        List {
            heroSection(item)
            repliesSection(item)
            sessionsSection(item)
            if let err = ideaStore.errorMessage {
                Text(err)
                    .font(.footnote)
                    .foregroundStyle(Color.amux.cinnabarDeep)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
        // Plain, not inset-grouped. The grouped style wraps every section in
        // a rounded card, which turned the replies into a settings screen —
        // a post and the things people said about it are one column of text,
        // not four forms.
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color.amux.mist)
        .toolbarBackground(Color.amux.mist.opacity(0.85), for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            composerArea
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
        }
        .navigationTitle(IdeaUIPresentation.singularTitle)
        .navigationBarTitleDisplayMode(.inline)
        // Tab-bar visibility hoisted to IdeasTab's NavigationStack root.
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    titleFocused = false
                    descriptionFocused = false
                    showNewSession = true
                } label: {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.title3)
                        .foregroundStyle(.primary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Start a session")
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                archiveMenu(for: item)
            }
        }
        .sheet(isPresented: $showNewSession) {
            NewSessionSheet(
                mqtt: mqtt,
                peerId: peerId,
                teamcluService: teamcluService,
                connectedAgentsStore: connectedAgentsStore,
                actorStore: actorStore,
                agentPresenceStore: agentPresenceStore,
                sessionsRepository: sessionsRepository,
                viewModel: sessionViewModel,
                preselectedIdeaId: item.id,
                onSessionCreated: { sessionKey in
                    showNewSession = false
                    navigationPath.append(sessionKey)
                }
            )
        }
        .fullScreenCover(isPresented: $showProgressCamera) {
            CameraImagePicker(
                onCapture: { url in
                    Task {
                        await addProgressImageAttachment(url, ideaID: item.id, teamID: item.teamID)
                        showProgressCamera = false
                    }
                },
                onCancel: { showProgressCamera = false }
            )
            .ignoresSafeArea()
        }
        .photosPicker(
            isPresented: $showProgressPhotoPicker,
            selection: $progressPhotoItems,
            maxSelectionCount: 5,
            matching: .images
        )
        .onChange(of: progressPhotoItems) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                    let url = FileManager.default.temporaryDirectory
                        .appendingPathComponent("idea-progress-\(UUID().uuidString).jpg")
                    try? data.write(to: url)
                    await addProgressImageAttachment(url, ideaID: self.ideaID, teamID: self.item?.teamID ?? "")
                }
                progressPhotoItems = []
            }
        }
    }

    // MARK: Hero

    @ViewBuilder
    private func heroSection(_ item: IdeaRecord) -> some View {
        Section {
            // The post, the way the feed shows it — byline, words, pictures,
            // then what the team has done with it. The fields stay editable
            // in place, but at a post's size rather than the 26pt headline
            // the board opened with.
            VStack(alignment: .leading, spacing: 10) {
                byline(item)

                TextField("Title", text: $localTitle, axis: .vertical)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.amux.onyx)
                    .lineLimit(1...4)
                    .focused($titleFocused)
                    .onSubmit { commitTitle(for: item) }
                    .onChange(of: titleFocused) { _, focused in
                        if !focused { commitTitle(for: item) }
                    }

                // No placeholder when it is empty and nobody is typing: a
                // post with no further details should look like a post with
                // no further details, not a form with a blank to fill. The
                // field is still there and still takes a tap.
                TextField(descriptionFocused || !localDescription.isEmpty ? "Add details…" : "",
                          text: $localDescription, axis: .vertical)
                    .font(.system(size: 15))
                    .foregroundStyle(Color.amux.basalt)
                    .lineSpacing(2)
                    .lineLimit(1...14)
                    .focused($descriptionFocused)
                    .onChange(of: descriptionFocused) { _, focused in
                        if !focused { commitDescription(for: item) }
                    }

                if !item.attachmentURLs.isEmpty {
                    IdeaFeedMedia(urls: item.attachmentURLs)
                }

                postActions(item)
                heroMetaStrip(item)
            }
            .padding(.top, 4)
            .padding(.bottom, 12)
            .overlay(alignment: .bottom) {
                // Where the post ends and what people said about it begins.
                Color.amux.hairline.frame(height: 0.5)
            }
        }
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 0, trailing: 16))
    }

    /// Avatar, who, when — and the status control at the trailing edge. On a
    /// card the status is a tag that only appears once it means something; on
    /// the post it is always there, because here it is the control.
    private func byline(_ item: IdeaRecord) -> some View {
        HStack(spacing: 10) {
            if let creator {
                AgentAvatar(actor: creator, size: 38)
            } else {
                Circle()
                    .fill(Color.amux.pebble)
                    .frame(width: 38, height: 38)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(creator?.displayName ?? String(localized: "Someone"))
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(Color.amux.onyx)
                    .lineLimit(1)
                Text(item.createdAt.relativeShort)
                    .font(.system(size: 12.5))
                    .foregroundStyle(Color.amux.slate)
            }
            Spacer(minLength: 8)
            statusPillMenu(for: item)
        }
    }

    /// Comment count comes from the loaded activities rather than the record's
    /// `commentCount`: the list aggregates that number, and by the time you
    /// are reading the post the replies themselves are in hand and may have
    /// grown since.
    private func postActions(_ item: IdeaRecord) -> some View {
        HStack(spacing: 28) {
            HStack(spacing: 6) {
                Image(systemName: "bubble.right")
                    .font(.system(size: 13.5))
                if commentCount > 0 {
                    Text(commentCount, format: .number)
                        .font(.system(size: 13))
                        .monospacedDigit()
                }
            }
            .foregroundStyle(Color.amux.slate)

            Button {
                Task { await ideaStore.setLiked(ideaID: item.id, liked: !item.likedByMe) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: item.likedByMe ? "heart.fill" : "heart")
                        .font(.system(size: 13.5))
                        .foregroundStyle(item.likedByMe ? Color.amux.cinnabar : Color.amux.slate)
                    if item.likeCount > 0 {
                        Text(item.likeCount, format: .number)
                            .font(.system(size: 13))
                            .monospacedDigit()
                            .foregroundStyle(Color.amux.slate)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(item.likedByMe ? "Unlike" : "Like")
            .accessibilityIdentifier("ideaDetail.likeButton")

            Spacer(minLength: 0)
        }
        .padding(.top, 2)
    }

    private var commentCount: Int {
        activities.filter(\.isProgress).count
    }

    private func statusPillMenu(for item: IdeaRecord) -> some View {
        // Status pill colors match the IdeaRow on the list:
        // OPEN earns Cinnabar (call-to-action / unclaimed work),
        // IN PROGRESS sits in Basalt on Pebble (quiet in-flight),
        // DONE finishes in Sage.
        let fg: Color = {
            if item.isDone       { return Color.amux.sage }
            if item.isInProgress { return Color.amux.basalt }
            return Color.amux.cinnabar
        }()
        let bg: Color = {
            if item.isDone       { return Color.amux.sage.opacity(0.12) }
            if item.isInProgress { return Color.amux.pebble }
            return Color.amux.cinnabar.opacity(0.10)
        }()
        return Menu {
            Picker("Status", selection: statusBinding(for: item)) {
                Text("Open").tag("open")
                Text("In Progress").tag("in_progress")
                Text("Done").tag("done")
            }
        } label: {
            HStack(spacing: 5) {
                Circle()
                    .fill(fg)
                    .frame(width: 6, height: 6)
                    .breathingOpacity(active: item.isInProgress, dim: 0.4)
                Text(item.statusLabel.uppercased())
                    .font(.system(size: 10.5, weight: .bold))
                    .tracking(0.3)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
            .foregroundStyle(fg)
            .padding(.horizontal, 9)
            .frame(height: 22)
            .background(Capsule().fill(bg))
        }
        // A Menu tints its own label from the accent colour, which is coral
        // here; `foregroundStyle` alone is not always enough to hold the two
        // quiet statuses against it.
        .tint(fg)
    }

    private func statusBinding(for item: IdeaRecord) -> Binding<String> {
        Binding(
            get: { item.status },
            set: { newValue in
                guard newValue != item.status else { return }
                Task {
                    await ideaStore.updateIdea(
                        ideaID: item.id,
                        title: item.title,
                        description: item.description,
                        status: newValue,
                        workspaceID: item.workspaceID
                    )
                }
            }
        )
    }

    @ViewBuilder
    private func heroMetaStrip(_ item: IdeaRecord) -> some View {
        // Creator and time moved into the byline; what is left is where the
        // work happens, and only when the idea names a workspace at all.
        HStack(spacing: 6) {
            if let name = workspaceName, !name.isEmpty {
                Text(name)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(Color.amux.basalt)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Color.amux.pebble))
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: Activity

    @ViewBuilder
    private func repliesSection(_ item: IdeaRecord) -> some View {
        if ideaStore.isLoadingActivities && activities.isEmpty {
            ProgressView()
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        } else if activities.isEmpty {
            // One quiet line, not the card an empty thread used to get. It
            // says the thread is empty rather than broken, and stops short of
            // telling anyone to fill it — the composer below is the invitation.
            Text("No replies yet")
                .font(.amuxSerif(15))
                .foregroundStyle(Color.amux.slate)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 28)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
        } else {
            ForEach(activities, id: \.id) { activity in
                IdeaActivityRow(
                    activity: activity,
                    actor: allActors.first { $0.actorId == activity.actorID },
                    isLast: true
                )
                .padding(.vertical, 10)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                .listRowSeparatorTint(Color.amux.hairline)
            }
        }
    }

    // MARK: Sessions

    @ViewBuilder
    private func sessionsSection(_ item: IdeaRecord) -> some View {
        // Only when the idea actually has sessions. "No sessions linked yet."
        // is a row that exists to say a row does not exist.
        if !relatedSessions.isEmpty {
            Section {
                ForEach(relatedSessions, id: \.sessionId) { session in
                    Button {
                        navigationPath.append("session:\(session.sessionId)")
                    } label: {
                        SessionLinkRow(session: session)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                }
            } header: {
                sectionHeader(String(localized: "Sessions"))
            }
        }
    }

    // MARK: Archive

    /// The archive control and its confirmation, for the toolbar menu. It used
    /// to be a full-width destructive button in a card of its own at the foot
    /// of the page — the loudest thing on a screen whose subject is a post.
    @ViewBuilder
    private func archiveMenu(for item: IdeaRecord) -> some View {
        Menu {
            Button(role: item.archived ? .none : .destructive) {
                showArchiveConfirm = true
            } label: {
                Label(item.archived ? "Unarchive" : "Archive",
                      systemImage: item.archived ? "tray.and.arrow.up" : "archivebox")
            }
            .disabled(isArchiving)
        } label: {
            Image(systemName: "ellipsis")
                .font(.title3)
                .foregroundStyle(.primary)
        }
        .accessibilityLabel("More")
        .confirmationDialog(
            item.archived ? "Unarchive this idea?" : "Archive this idea?",
            isPresented: $showArchiveConfirm,
            titleVisibility: .visible
        ) {
            Button(item.archived ? "Unarchive" : "Archive",
                   role: item.archived ? .none : .destructive) {
                performArchive(for: item)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(item.archived
                 ? "The idea will reappear in the main list."
                 : "Archived ideas are hidden from the main list but can be restored later.")
        }
    }

    // MARK: Composer

    private var composerArea: some View {
        VStack(spacing: 6) {
            // Strip only renders when there's at least one selected
            // attachment — the add affordance lives inside the composer
            // capsule below to keep the bottom bar visually unified.
            if !progressImageAttachments.isEmpty {
                IdeaImageAttachmentStrip(
                    urls: progressImageAttachments,
                    uploads: progressImageUploads,
                    onRemove: removeProgressImageAttachment
                )
                .padding(.horizontal, 2)
            }

            composerCapsule
        }
    }

    private var composerCapsule: some View {
        HStack(spacing: 8) {
            Button {
                showProgressImageSourceDialog = true
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(Color.amux.basalt)
                    .frame(width: 30, height: 30)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(isSubmittingProgress)
            .accessibilityLabel("Add image")
            // Attach dialog to the button so iOS 26's popover-style
            // confirmation anchors at the "+" button, not at the top of
            // the screen where the body-level modifier was placed.
            .confirmationDialog(
                "Add image",
                isPresented: $showProgressImageSourceDialog,
                titleVisibility: .hidden
            ) {
                Button("Photo Library") { showProgressPhotoPicker = true }
                Button("Camera") { showProgressCamera = true }
                Button("Cancel", role: .cancel) {}
            }

            TextField("Submit progress, or @mention an agent…", text: $composerText, axis: .vertical)
                .lineLimit(1...3)
                .font(.subheadline)
                .padding(.leading, 2)
            Button {
                submitProgress()
            } label: {
                if isSubmittingProgress {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 52, height: 30)
                        .background(Color.amux.onyx.opacity(0.18), in: Capsule())
                } else {
                    Text("Submit")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.amux.mist)
                        .frame(width: 52, height: 30)
                        .background(Color.amux.onyx, in: Capsule())
                }
            }
            .buttonStyle(.plain)
            .disabled(!canSubmitProgress)
            .opacity(canSubmitProgress ? 1 : 0.4)
        }
        .padding(6)
        .background(
            Capsule()
                .fill(.ultraThinMaterial)
        )
        .overlay(
            Capsule().strokeBorder(Color.amux.hairline, lineWidth: 0.5)
        )
        .shadow(color: Color.amux.onyx.opacity(0.08), radius: 18, y: 6)
    }

    private var hasUploadingProgressImages: Bool {
        progressImageUploads.values.contains { $0.uploadState == .pending || $0.uploadState == .uploading }
    }

    private var hasFailedProgressImages: Bool {
        progressImageUploads.values.contains { $0.uploadState == .failed }
    }

    private var uploadedProgressImageURLs: [URL] {
        progressImageAttachments.compactMap { localURL in
            progressImageUploads[localURL.absoluteString]?.storageURL.flatMap(URL.init(string:))
        }
    }

    private var canSubmitProgress: Bool {
        guard !isSubmittingProgress, !hasUploadingProgressImages, !hasFailedProgressImages else { return false }
        return !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !uploadedProgressImageURLs.isEmpty
    }

    // MARK: Helpers

    private func sectionHeader(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.caption)
            .fontWeight(.semibold)
            .tracking(0.3)
            .foregroundStyle(.secondary)
            .textCase(nil)
    }

    private func seedLocals() {
        guard !didSeedLocals, let item else { return }
        localTitle = item.title
        localDescription = item.description
        didSeedLocals = true
    }

    private func commitTitle(for item: IdeaRecord) {
        let trimmed = localTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != item.title else {
            if trimmed.isEmpty { localTitle = item.title }
            return
        }
        Task {
            await ideaStore.updateIdea(
                ideaID: item.id,
                title: trimmed,
                description: item.description,
                status: item.status,
                workspaceID: item.workspaceID
            )
        }
    }

    private func commitDescription(for item: IdeaRecord) {
        guard localDescription != item.description else { return }
        Task {
            await ideaStore.updateIdea(
                ideaID: item.id,
                title: item.title,
                description: localDescription,
                status: item.status,
                workspaceID: item.workspaceID
            )
        }
    }

    private func performArchive(for item: IdeaRecord) {
        guard !isArchiving else { return }
        isArchiving = true
        Task {
            let ok = await ideaStore.setArchived(ideaID: item.id, archived: !item.archived)
            await MainActor.run {
                isArchiving = false
                if ok, !item.archived {
                    dismiss()
                }
            }
        }
    }

    private func submitProgress() {
        let trimmed = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSubmitProgress else { return }
        let attachments = uploadedProgressImageURLs
        let content = trimmed.isEmpty
            ? "Attached \(attachments.count) image\(attachments.count == 1 ? "" : "s")."
            : trimmed
        isSubmittingProgress = true
        Task {
            let ok = await ideaStore.createActivity(
                ideaID: ideaID,
                activityType: "progress",
                content: content,
                attachmentURLs: attachments
            )
            if ok {
                await ideaStore.reloadActivities(ideaID: ideaID)
                await MainActor.run {
                    composerText = ""
                    progressImageAttachments = []
                    progressImageUploads = [:]
                    isSubmittingProgress = false
                }
            } else {
                await MainActor.run {
                    isSubmittingProgress = false
                }
            }
        }
    }

    private func addProgressImageAttachment(_ url: URL, ideaID: String, teamID: String) async {
        guard !progressImageAttachments.contains(url) else { return }
        guard let manager = ensureProgressUploadManager(teamID: teamID) else {
            ideaStore.errorMessage = String(localized: "Image upload is unavailable for this team.")
            return
        }
        progressImageAttachments.append(url)
        do {
            let upload = try await manager.startUpload(
                filePath: url,
                messageID: "idea-progress-\(ideaID)-\(UUID().uuidString)",
                sessionID: "ideas/\(ideaID)",
                teamID: teamID
            )
            progressImageUploads[url.absoluteString] = upload
        } catch {
            ideaStore.errorMessage = error.localizedDescription
        }
    }

    private func removeProgressImageAttachment(_ url: URL) {
        progressImageAttachments.removeAll { $0 == url }
        progressImageUploads.removeValue(forKey: url.absoluteString)
    }

    private func ensureProgressUploadManager(teamID: String) -> AttachmentUploadManager? {
        guard !teamID.isEmpty else { return nil }
        if let progressUploadManager { return progressUploadManager }
        guard let manager = try? AttachmentUploadManager.fromMainBundle(modelContext: modelContext) else {
            return nil
        }
        progressUploadManager = manager
        return manager
    }
}

// MARK: - Activity row

private struct IdeaActivityRow: View {
    let activity: IdeaActivityRecord
    let actor: CachedActor?
    let isLast: Bool

    private var actorName: String {
        guard let displayName = actor?.displayName.trimmingCharacters(in: .whitespacesAndNewlines),
              !displayName.isEmpty else {
            return String(localized: "Unknown")
        }
        return displayName
    }

    private var iconName: String {
        if activity.isStatusChange { return "arrow.triangle.2.circlepath" }
        if activity.isReorder { return "arrow.up.arrow.down" }
        return "text.line.first.and.arrowtriangle.forward"
    }

    private var activityLabel: String {
        if activity.isStatusChange { return String(localized: "Status changed") }
        if activity.isReorder { return String(localized: "Reordered") }
        return String(localized: "Progress")
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(Color.amux.pebble)
                    Image(systemName: iconName)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(activity.isStatusChange ? Color.amux.basalt : Color.amux.cinnabar)
                }
                .frame(width: 24, height: 24)

                if !isLast {
                    Rectangle()
                        .fill(Color.amux.hairline)
                        .frame(width: 1)
                        .frame(maxHeight: .infinity)
                        .padding(.top, 4)
                }
            }
            .frame(width: 24)

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    if let actor {
                        AgentAvatar(actor: actor, size: 20, cornerRadius: 5)
                    }
                    Text(actorName)
                        .font(.caption)
                    if let actor, actor.isAgent {
                        Text("AGENT")
                            .font(.system(size: 9, weight: .bold))
                            .tracking(0.3)
                            .foregroundStyle(Color.amux.basalt)
                            .padding(.horizontal, 5)
                            .frame(height: 14)
                            .background(
                                RoundedRectangle(cornerRadius: 3, style: .continuous)
                                    .fill(Color.amux.pebble)
                            )
                    }
                    Spacer()
                    Text(activity.createdAt.relativeShort)
                        .font(.caption2)
                        .foregroundStyle(Color.amux.slate)
                }

                Text(activityLabel)
                    .font(.caption2)
                    .foregroundStyle(Color.amux.slate)

                Text(activity.content.isEmpty ? activity.activityType : activity.content)
                    .font(.subheadline)
                    .foregroundStyle(Color.amux.onyx.opacity(0.85))
                    .lineLimit(nil)

                if !activity.attachmentURLs.isEmpty {
                    IdeaActivityImageGrid(urls: activity.attachmentURLs)
                        .padding(.top, 2)
                }
            }
            .padding(.bottom, isLast ? 0 : 14)
        }
        .padding(.top, 2)
    }
}

// MARK: - Session link row

private struct SessionLinkRow: View {
    let session: Session

    private var lastMessage: String {
        session.lastMessagePreview.isEmpty ? String(localized: "No messages yet.") : session.lastMessagePreview
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: session.primaryAgentId == nil ? "person.2.fill" : "cpu")
                .font(.body)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title.isEmpty ? String(localized: "Untitled Session") : session.title)
                    .font(.body)
                    .fontWeight(.medium)
                    .lineLimit(1)
                Text(lastMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if let at = session.lastMessageAt ?? Optional(session.createdAt) {
                Text(at, style: .relative)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }
}

// MARK: - Shared helpers used across detail surfaces

/// Avatar tile reused across detail surfaces. Mirrors the palette logic in
/// the Actors list so an actor reads as the "same" person across views.
struct AgentAvatar: View {
    let actor: CachedActor
    var size: CGFloat = 40
    var cornerRadius: CGFloat = 10

    private var initials: String {
        let parts = actor.displayName
            .split(whereSeparator: { $0.isWhitespace || $0 == "·" })
            .prefix(2)
        let s = parts.compactMap { $0.first }.map(String.init).joined().uppercased()
        return s.isEmpty ? String(actor.displayName.prefix(1)).uppercased() : s
    }

    private struct Style { let bg: Color; let fg: Color }

    private var style: Style {
        // Hai palette — every avatar background is Pebble. Foregrounds are
        // chosen from the ink-and-stone family: Cinnabar is rationed for a
        // single hash slot (one variant per actor stays warm, all others
        // sit in Basalt or Slate). The previous brand rainbow has been
        // retired per the "spare the vermillion" principle.
        let palette: [Color] = [
            Color.amux.basalt,
            Color.amux.slate,
            Color.amux.cinnabar,
            Color.amux.basalt,
        ]
        let h = abs(actor.actorId.unicodeScalars.reduce(0) { $0 &+ Int($1.value) })
        return Style(bg: Color.amux.pebble, fg: palette[h % palette.count])
    }

    var body: some View {
        ZStack {
            if actor.isAgent {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(style.bg)
            } else {
                Circle().fill(style.bg)
            }
            if let urlString = actor.avatarURL, let url = URL(string: urlString) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        initialsLabel
                    }
                }
            } else {
                initialsLabel
            }
        }
        .frame(width: size, height: size)
        .clipShape(actor.isAgent
            ? AnyShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            : AnyShape(Circle()))
    }

    private var initialsLabel: some View {
        Text(initials)
            .font(.system(size: size * 0.36, weight: .bold))
            .tracking(-0.3)
            .foregroundStyle(style.fg)
    }
}


private extension Date {
    /// Short relative date string ("2h", "3d", "now") — matches the listed
    /// Sessions row format so detail surfaces feel consistent.
    var relativeShort: String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: self, relativeTo: .now)
    }
}
