import SwiftUI
import SwiftData
import PhotosUI
import UIKit
import AMUXSharedUI
import AMUXCore

public struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    /// Injected by AMUXApp's `ContentView` via `.environment(onboarding)`.
    /// Read at this scope to gate the anonymous-upgrade banner. Marked
    /// optional so the (unused) macOS shell or any host that forgets to
    /// inject still compiles cleanly.
    @Environment(AppOnboardingCoordinator.self) private var onboarding: AppOnboardingCoordinator?

    let connectedAgentsStore: ConnectedAgentsStore?
    let agentPresenceStore: AgentPresenceStore?
    let activeTeam: TeamSummary?
    let onSignOut: (() -> Void)?
    let notificationPrefsStore: NotificationPrefsStore?
    let teamRepository: (any TeamRepository)?
    let actorRepository: (any ActorRepository)?

    @State private var teamDetails: TeamDetails?
    @State private var teamLoadError: String?

    @State private var teamDefaultAgentID: String? = nil
    @State private var teamDefaultAgentLoaded = false
    @State private var teamDefaultAgentSaveError: String?

    /// The caller's own default (`members.default_agent_id`). Nil means
    /// "follow the team default".
    @State private var memberDefaultAgentID: String? = nil
    @State private var memberDefaultAgentLoaded = false
    @State private var memberDefaultAgentSaveError: String?

    @State private var showSignOutConfirm = false
    @State private var showPendingInvites = false
    @State private var showEditProfileSheet = false
    @State private var showTeamSwitchSheet = false

    /// Cached actor row for the current member, used to source the
    /// identity-card display name without an extra RPC.
    @Query private var cachedActors: [CachedActor]

    public init(connectedAgentsStore: ConnectedAgentsStore?,
                agentPresenceStore: AgentPresenceStore? = nil,
                activeTeam: TeamSummary? = nil,
                onSignOut: (() -> Void)? = nil,
                notificationPrefsStore: NotificationPrefsStore? = nil,
                teamRepository: (any TeamRepository)? = nil,
                actorRepository: (any ActorRepository)? = nil) {
        self.connectedAgentsStore = connectedAgentsStore
        self.agentPresenceStore = agentPresenceStore
        self.activeTeam = activeTeam
        self.onSignOut = onSignOut
        self.notificationPrefsStore = notificationPrefsStore
        self.teamRepository = teamRepository
        self.actorRepository = actorRepository
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "—"
    }

    private var currentActorID: String? {
        onboarding?.currentContext?.memberActorID
    }

    /// The Cloud API endpoint the app is currently talking to (Settings
    /// override or bundled default). Shown in About for support/diagnostics.
    private var cloudAPIAddress: String {
        CloudAPIConfigurationStore.storedCloudAPIURL() ?? "—"
    }

    /// The MQTT broker host the app connects to — a Settings override, else the
    /// address the Cloud API handed out at bootstrap. Useful when diagnosing
    /// connection issues. Nothing is bundled, so "—" means bootstrap has not
    /// answered yet on this device.
    private var mqttBrokerAddress: String {
        let host = UserDefaults.standard.string(forKey: "teamclu_broker_host")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let host, !host.isEmpty { return host }
        return UserDefaultsBrokerConfigCache().load()?.host ?? "—"
    }

    private var currentActor: CachedActor? {
        guard let id = currentActorID else { return nil }
        return cachedActors.first(where: { $0.actorId == id })
    }

    /// Friendly display name for the identity card.
    private var displayName: String {
        if let name = currentActor?.displayName, !name.isEmpty { return name }
        return "—"
    }

    private var initials: String {
        ProfileAvatarView.initials(for: displayName)
    }

    public var body: some View {
        NavigationStack {
            ZStack {
                Color.amux.mist.ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 18) {
                        identityCard
                        currentTeamSection
                        defaultAgentsSection
                        connectedAgentsSection
                        if let store = notificationPrefsStore {
                            notificationsSection(store: store)
                        }
                        aboutSection
                        if let id = currentActorID, !id.isEmpty {
                            footerCaption(actorID: id)
                        }
                    }
                    .padding(.top, 12)
                    .padding(.bottom, 24)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.title3)
                            .foregroundStyle(Color.amux.basalt)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close")
                    .accessibilityIdentifier("settings.closeButton")
                }
            }
            .sheet(isPresented: $showPendingInvites) {
                if let onboarding {
                    PendingInvitesSheet(coordinator: onboarding)
                        .presentationDetents([.medium, .large])
                }
            }
            .sheet(isPresented: $showTeamSwitchSheet) {
                if let onboarding {
                    TeamSwitchSheet(
                        coordinator: onboarding,
                        currentTeamID: activeTeam?.id
                    ) { teamID, choices in
                        // Close both sheets before switching: the switch
                        // flips the route through the splash and rebuilds
                        // the whole shell underneath them.
                        showTeamSwitchSheet = false
                        dismiss()
                        Task { await onboarding.switchTeam(to: teamID, choices: choices) }
                    }
                    .presentationDetents([.medium, .large])
                }
            }
            .task {
                // Pending invites surface as a Team-card row; refresh when
                // Settings opens so the row/badge reflects reality.
                await onboarding?.refreshPendingInvites()
            }
            .sheet(isPresented: $showEditProfileSheet) {
                if let actorID = currentActorID {
                    EditProfileSheet(
                        actorID: actorID,
                        initialDisplayName: displayName == "—" ? "" : displayName,
                        initialAvatarURL: currentActor?.avatarURL,
                        teamName: activeTeam?.name,
                        actorRepository: actorRepository,
                        onSaved: { record in
                            ActorCacheSynchronizer.upsert(record, modelContext: modelContext)
                            try? modelContext.save()
                        }
                    )
                    .presentationDetents([.medium])
                }
            }
            .task {
                await loadTeam()
                await connectedAgentsStore?.reload()
                await loadDefaultAgents()
            }
            .refreshable { await connectedAgentsStore?.reload() }
        }
    }

    // MARK: - Identity card

    private var identityCard: some View {
        Button {
            guard currentActorID != nil else { return }
            showEditProfileSheet = true
        } label: {
            HStack(spacing: 14) {
                ProfileAvatarView(
                    displayName: displayName,
                    avatarURL: currentActor?.avatarURL,
                    size: 56,
                    fontSize: 20
                )

                VStack(alignment: .leading, spacing: 4) {
                    Text(displayName)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color.amux.onyx)
                        .lineLimit(1)

                    if let email = onboarding?.currentUserEmail {
                        Text(email)
                            .font(.system(size: 12))
                            .foregroundStyle(Color.amux.basalt.opacity(0.6))
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Image(systemName: "pencil")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Color.amux.basalt.opacity(0.75))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(SettingsCardBackground())
        }
        .buttonStyle(.plain)
        .disabled(currentActorID == nil)
        .padding(.horizontal, 16)
    }

    private func roleBadge(_ role: String) -> some View {
        let label = role.lowercased() == "owner" ? String(localized: "Owner") : role.capitalized
        return Text(label.uppercased())
            .font(.system(size: 10, weight: .bold))
            .tracking(0.3)
            .foregroundStyle(Color.amux.basalt)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(Color.amux.basalt.opacity(0.14))
            )
    }

    // MARK: - Connected agents (was "Daemon" in prototype)

    private var connectedAgentsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionLabel(String(localized: "Connected personal agents"))
            VStack(spacing: 0) {
                if let store = connectedAgentsStore {
                    let personalAgents = store.agents.filter { $0.visibility == "personal" }
                    if personalAgents.isEmpty && !store.isLoading {
                        emptyAgentsRow
                    } else {
                        ForEach(Array(personalAgents.enumerated()), id: \.element.id) { idx, agent in
                            connectedAgentRow(agent)
                            if idx != personalAgents.count - 1 {
                                Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
                                    .padding(.leading, 14)
                            }
                        }
                    }
                    if let err = store.errorMessage {
                        Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
                        Text(err)
                            .font(.footnote)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                            .padding(14)
                    }
                } else {
                    Text("Agent list unavailable.")
                        .font(.system(size: 14))
                        .foregroundStyle(Color.amux.basalt)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .background(SettingsCardBackground())
            .padding(.horizontal, 16)
        }
    }

    private func connectedAgentRow(_ agent: ConnectedAgent) -> some View {
        // The broker's retained state, not the heartbeat: a daemon that just
        // died has a seconds-old last_active_at but an offline Last Will.
        let isOnline = agent.isOnline(
            devicePresence: agentPresenceStore?.presence(forAgent: agent.id) ?? .unknown
        )
        let dotColor: Color = isOnline ? Color.amux.sage : Color.amux.slate
        let agentTypeLabel: String = {
            switch agent.defaultAgentType {
            case "claude", "claude_code": return "Claude"
            case "opencode":    return "OpenCode"
            case "codex":       return "Codex"
            default:            return ""
            }
        }()
        let metaParts: [String] = [agentTypeLabel, agent.permissionLevel, agent.visibility]
            .filter { !$0.isEmpty }
        let meta = metaParts.joined(separator: " · ")
        return HStack(spacing: 10) {
            ZStack {
                Circle().fill(dotColor)
            }
            .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 2) {
                Text(agent.displayName)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(Color.amux.onyx)
                    .lineLimit(1)
                Text(meta.isEmpty ? (isOnline ? String(localized: "online") : String(localized: "offline")) : meta)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(Color.amux.basalt.opacity(0.75))
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if agent.isOwner {
                Button("Share to team") {
                    Task { await connectedAgentsStore?.shareToTeam(agentID: agent.id) }
                }
                .buttonStyle(.borderless)
                .font(.system(size: 13, weight: .semibold))
            }
            Text(isOnline ? "Online" : "Offline")
                .font(.system(size: 13))
                .foregroundStyle(dotColor)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private var emptyAgentsRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("No agents connected to you yet.")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.amux.onyx)
            Text("Personal agents registered from your devices will appear here.")
                .font(.footnote)
                .foregroundStyle(Color.amux.basalt)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Current team

    /// True when the current member role allows writing the team default agent.
    private var canEditTeamDefaultAgent: Bool {
        guard let role = activeTeam?.role.lowercased() else { return false }
        return role == "owner" || role == "admin"
    }

    /// Team-visible agents from the connected agents store.
    private var teamAgents: [ConnectedAgent] {
        connectedAgentsStore?.agents.filter { $0.visibility == "team" } ?? []
    }

    /// Agents the caller may pick as their own default: every team-visible
    /// agent plus personal agents they own (mirrors the
    /// `set_member_default_agent` visibility gate).
    private var memberDefaultCandidates: [ConnectedAgent] {
        connectedAgentsStore?.agents.filter { $0.visibility == "team" || $0.isOwner } ?? []
    }

    /// Resolves an agent id to a display name. The connected list only holds
    /// agents visible to the caller, so fall back to the actor cache before
    /// giving up — a stale default must still read as *something*.
    private func agentName(for id: String) -> String {
        if let agent = connectedAgentsStore?.agents.first(where: { $0.id == id }) {
            return agent.displayName
        }
        if let cached = cachedActors.first(where: { $0.actorId == id }), !cached.displayName.isEmpty {
            return cached.displayName
        }
        return String(localized: "Unavailable agent")
    }

    @ViewBuilder
    private var currentTeamSection: some View {
        if let team = activeTeam {
            VStack(alignment: .leading, spacing: 8) {
                SettingsSectionLabel(String(localized: "Current Team"))
                VStack(spacing: 0) {
                    HStack(alignment: .center, spacing: 12) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(team.name)
                                .font(.system(size: 20, weight: .semibold))
                                .foregroundStyle(Color.amux.onyx)
                                .lineLimit(1)
                            HStack(spacing: 6) {
                                roleBadge(team.role)
                                if let orgName = teamDetails?.orgName, !orgName.isEmpty, orgName != team.name {
                                    Text(orgName)
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(Color.amux.basalt.opacity(0.75))
                                        .lineLimit(1)
                                }
                            }
                        }
                        Spacer(minLength: 8)
                        Button {
                            showTeamSwitchSheet = true
                        } label: {
                            Label("Switch Team", systemImage: "arrow.left.arrow.right")
                                .font(.system(size: 13.5, weight: .semibold))
                        }
                        .buttonStyle(.bordered)
                        .tint(Color.amux.cinnabar)
                        .disabled(onboarding == nil)
                        .accessibilityIdentifier("settings.switchTeamButton")
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 14)

                    if let onboarding, !onboarding.pendingInvites.isEmpty {
                        Divider().background(Color.amux.hairline).padding(.leading, 14)
                        Button {
                            showPendingInvites = true
                        } label: {
                            HStack {
                                Text("Pending Invites")
                                    .font(.system(size: 14.5, weight: .medium))
                                    .foregroundStyle(Color.amux.onyx)
                                Spacer()
                                Text("\(onboarding.pendingInvites.count)")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(Color.amux.mist)
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 2)
                                    .background(Color.amux.cinnabar, in: Capsule())
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 13)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("settings.pendingInvitesButton")
                    }

                    Divider().background(Color.amux.hairline).padding(.leading, 14)
                    NavigationLink {
                        TeamInfoView(details: teamDetails, loadError: teamLoadError)
                    } label: {
                        HStack {
                            Text("Team Info")
                                .font(.system(size: 14.5))
                                .foregroundStyle(Color.amux.onyx)
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(Color.amux.slate)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 13)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("settings.teamInfoButton")
                }
                .background(SettingsCardBackground())
                .padding(.horizontal, 16)
            }
        }
    }

    // MARK: - Default agents

    /// Who answers a new session: the member's own default if set, else the
    /// team default (same resolution as `get_effective_default_agent`).
    private var effectiveDefaultAgentID: String? {
        memberDefaultAgentID ?? teamDefaultAgentID
    }

    @ViewBuilder
    private var defaultAgentsSection: some View {
        if activeTeam != nil {
            VStack(alignment: .leading, spacing: 8) {
                SettingsSectionLabel(String(localized: "Default Agent"))
                VStack(spacing: 0) {
                    memberDefaultAgentRow
                    Divider().background(Color.amux.hairline).padding(.leading, 14)
                    teamDefaultAgentRow
                }
                .background(SettingsCardBackground())
                .padding(.horizontal, 16)

                if memberDefaultAgentLoaded && teamDefaultAgentLoaded {
                    defaultAgentsFootnote
                }
            }
        }
    }

    private var memberDefaultAgentRow: some View {
        defaultAgentRow(
            title: String(localized: "Personal Default Agent"),
            emptyLabel: String(localized: "Follow team default"),
            selection: memberDefaultAgentID,
            candidates: memberDefaultCandidates,
            isLoaded: memberDefaultAgentLoaded,
            isEditable: actorRepository != nil,
            isEffective: memberDefaultAgentID != nil,
            saveError: memberDefaultAgentSaveError,
            accessibilityID: "settings.memberDefaultAgentPicker"
        ) { newID in
            let previousID = memberDefaultAgentID
            memberDefaultAgentID = newID
            memberDefaultAgentSaveError = nil
            Task { await applyMemberDefaultAgent(newID, previousID: previousID) }
        }
    }

    private var teamDefaultAgentRow: some View {
        defaultAgentRow(
            title: String(localized: "Team Default Agent"),
            emptyLabel: String(localized: "Not set"),
            selection: teamDefaultAgentID,
            candidates: teamAgents,
            isLoaded: teamDefaultAgentLoaded,
            isEditable: canEditTeamDefaultAgent && actorRepository != nil,
            isEffective: memberDefaultAgentID == nil && teamDefaultAgentID != nil,
            saveError: teamDefaultAgentSaveError,
            accessibilityID: "settings.teamDefaultAgentPicker"
        ) { newID in
            let previousID = teamDefaultAgentID
            teamDefaultAgentID = newID
            teamDefaultAgentSaveError = nil
            Task { await applyTeamDefaultAgent(newID, previousID: previousID) }
        }
    }

    /// One default-agent row: a menu picker when editable, plain text
    /// otherwise. `isEffective` marks the row new sessions actually use.
    @ViewBuilder
    private func defaultAgentRow(
        title: String,
        emptyLabel: String,
        selection: String?,
        candidates: [ConnectedAgent],
        isLoaded: Bool,
        isEditable: Bool,
        isEffective: Bool,
        saveError: String?,
        accessibilityID: String,
        onChange: @escaping (String?) -> Void
    ) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.system(size: 14.5))
                    .foregroundStyle(Color.amux.onyx)
                    .lineLimit(1)
                    .layoutPriority(1)
                if isEffective {
                    Circle()
                        .fill(Color.amux.cinnabar)
                        .frame(width: 6, height: 6)
                        .accessibilityLabel(Text("In effect"))
                }
                Spacer(minLength: 8)
                if !isLoaded {
                    ProgressView().controlSize(.small)
                } else if isEditable {
                    Menu {
                        Picker(title, selection: Binding(
                            get: { selection ?? "" },
                            set: { onChange($0.isEmpty ? nil : $0) }
                        )) {
                            Text(emptyLabel).tag("")
                            ForEach(candidates) { agent in
                                Text(agent.displayName).tag(agent.id)
                            }
                            // Keep a stale selection (agent unshared or no
                            // longer visible) representable instead of
                            // silently reading as the empty option.
                            if let selection, !candidates.contains(where: { $0.id == selection }) {
                                Text(agentName(for: selection)).tag(selection)
                            }
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text(selection.map(agentName(for:)) ?? emptyLabel)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 10, weight: .semibold))
                        }
                        .font(.system(size: 13.5))
                        .foregroundStyle(Color.amux.basalt)
                    }
                    .accessibilityIdentifier(accessibilityID)
                } else {
                    Text(selection.map(agentName(for:)) ?? emptyLabel)
                        .font(.system(size: 13.5))
                        .foregroundStyle(Color.amux.basalt)
                        .lineLimit(1)
                        .accessibilityIdentifier(accessibilityID)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 13)

            if let saveError {
                Text(saveError)
                    .font(.footnote)
                    .foregroundStyle(Color.amux.cinnabarDeep)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var defaultAgentsFootnote: some View {
        let text: String = {
            if let id = effectiveDefaultAgentID {
                return String(localized: "New sessions go to \(agentName(for: id)). Your personal default overrides the team default.")
            }
            return String(localized: "No default agent yet. Pick a personal default, or ask a team admin to set one for the team.")
        }()
        return Text(text)
            .font(.system(size: 12))
            .foregroundStyle(Color.amux.basalt.opacity(0.7))
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 24)
            .accessibilityIdentifier("settings.defaultAgentFootnote")
    }

    // MARK: - Notifications

    private func notificationsSection(store: NotificationPrefsStore) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionLabel(String(localized: "Preferences"))
            VStack(spacing: 0) {
                NavigationLink {
                    NotificationsSettingsView(store: store)
                } label: {
                    HStack {
                        Text("Notifications")
                            .font(.system(size: 14.5))
                            .foregroundStyle(Color.amux.onyx)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Color.amux.slate)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 13)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .background(SettingsCardBackground())
            .padding(.horizontal, 16)
        }
    }

    // MARK: - About + Sign out

    private var aboutSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsSectionLabel(String(localized: "About"))
            VStack(spacing: 0) {
                SettingsRow(
                    label: String(localized: "Version"),
                    value: "\(appVersion) (\(buildNumber))",
                    valueIsMonospaced: true
                )
                Divider().background(Color.amux.hairline).padding(.leading, 14)
                SettingsRow(
                    label: "Cloud API",
                    value: cloudAPIAddress,
                    valueIsMonospaced: true
                )
                Divider().background(Color.amux.hairline).padding(.leading, 14)
                SettingsRow(
                    label: "MQTT",
                    value: mqttBrokerAddress,
                    valueIsMonospaced: true
                )
                if onSignOut != nil {
                    Divider().background(Color.amux.hairline).padding(.leading, 14)
                    Button {
                        showSignOutConfirm = true
                    } label: {
                        HStack {
                            Text("Sign Out")
                                .font(.system(size: 14.5, weight: .medium))
                                .foregroundStyle(Color.amux.cinnabarDeep)
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 13)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("settings.signOutButton")
                    // Attach the confirmation dialog to the button that
                    // triggers it so iOS 26's Liquid Glass popover style
                    // anchors at the tapped row. When the modifier was on
                    // the NavigationStack root, the arrow pointed at the
                    // top of the sheet (near the identity card) instead
                    // of the bottom-of-list Sign Out row the user tapped.
                    .confirmationDialog(
                        "Sign out of Teamclu?",
                        isPresented: $showSignOutConfirm,
                        titleVisibility: .visible
                    ) {
                        Button("Sign Out", role: .destructive) {
                            let action = onSignOut
                            dismiss()
                            action?()
                        }
                        Button("Cancel", role: .cancel) {}
                    }
                }
            }
            .background(SettingsCardBackground())
            .padding(.horizontal, 16)
        }
    }

    private func footerCaption(actorID: String) -> some View {
        Text(actorID)
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(Color.amux.slate)
            .padding(.top, 4)
            .frame(maxWidth: .infinity)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 24)
    }

    private func loadTeam() async {
        guard let team = activeTeam else { return }
        guard let repo = teamRepository else { return }
        do {
            teamDetails = try await repo.loadDetails(teamID: team.id)
            teamLoadError = nil
        } catch {
            teamLoadError = error.localizedDescription
        }
    }

    private func loadDefaultAgents() async {
        guard let team = activeTeam, let repo = actorRepository else { return }
        memberDefaultAgentID = try? await repo.getMemberDefaultAgent(teamID: team.id)
        teamDefaultAgentID = try? await repo.getTeamDefaultAgent(teamID: team.id)
        memberDefaultAgentLoaded = true
        teamDefaultAgentLoaded = true
    }

    private func applyMemberDefaultAgent(_ agentID: String?, previousID: String?) async {
        guard let team = activeTeam, let repo = actorRepository else { return }
        do {
            let confirmed = try await repo.setMemberDefaultAgent(teamID: team.id, agentID: agentID)
            memberDefaultAgentID = confirmed
            memberDefaultAgentSaveError = nil
        } catch {
            memberDefaultAgentID = previousID
            memberDefaultAgentSaveError = error.localizedDescription
        }
    }

    private func applyTeamDefaultAgent(_ agentID: String?, previousID: String?) async {
        guard let team = activeTeam, let repo = actorRepository else { return }
        do {
            let confirmed = try await repo.setTeamDefaultAgent(teamID: team.id, agentID: agentID)
            teamDefaultAgentID = confirmed
            teamDefaultAgentSaveError = nil
        } catch {
            teamDefaultAgentID = previousID
            teamDefaultAgentSaveError = error.localizedDescription
        }
    }
}

/// Read-only team metadata, one tap below the Current Team card so the
/// Settings root stays about what you can act on.
private struct TeamInfoView: View {
    let details: TeamDetails?
    let loadError: String?

    var body: some View {
        ZStack {
            Color.amux.mist.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 0) {
                    if let details {
                        if let orgName = details.orgName, !orgName.isEmpty {
                            SettingsRow(label: String(localized: "Org Name"), value: orgName)
                            Divider().background(Color.amux.hairline).padding(.leading, 14)
                        }
                        SettingsRow(label: String(localized: "Team Name"), value: details.name)
                        Divider().background(Color.amux.hairline).padding(.leading, 14)
                        SettingsRow(label: String(localized: "Owner"), value: details.ownerDisplayName ?? "—")
                        Divider().background(Color.amux.hairline).padding(.leading, 14)
                        SettingsRow(
                            label: String(localized: "Created"),
                            value: details.createdAt.formatted(date: .abbreviated, time: .shortened)
                        )
                        Divider().background(Color.amux.hairline).padding(.leading, 14)
                        SettingsRow(label: "ID", value: details.id, valueIsMonospaced: true)
                    } else if let loadError {
                        Text(loadError)
                            .font(.footnote)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ProgressView()
                            .padding(14)
                            .frame(maxWidth: .infinity)
                    }
                }
                .background(SettingsCardBackground())
                .padding(.horizontal, 16)
                .padding(.top, 12)
            }
        }
        .navigationTitle("Team Info")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct EditProfileSheet: View {
    @Environment(\.dismiss) private var dismiss

    let actorID: String
    let initialDisplayName: String
    let initialAvatarURL: String?
    let teamName: String?
    let actorRepository: (any ActorRepository)?
    let onSaved: (ActorRecord) -> Void

    @State private var displayName: String
    @State private var avatarURL: String?
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var selectedAvatarImage: UIImage?
    @State private var selectedAvatarData: Data?
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(
        actorID: String,
        initialDisplayName: String,
        initialAvatarURL: String?,
        teamName: String?,
        actorRepository: (any ActorRepository)? = nil,
        onSaved: @escaping (ActorRecord) -> Void
    ) {
        self.actorID = actorID
        self.initialDisplayName = initialDisplayName
        self.initialAvatarURL = initialAvatarURL
        self.teamName = teamName
        self.actorRepository = actorRepository
        self.onSaved = onSaved
        _displayName = State(initialValue: initialDisplayName)
        _avatarURL = State(initialValue: initialAvatarURL)
    }

    private var trimmedName: String {
        displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSave: Bool {
        !trimmedName.isEmpty && !isSaving
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                VStack(spacing: 10) {
                    avatarPreview
                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        Text("Change Photo")
                            .font(.system(size: 13.5, weight: .semibold))
                            .foregroundStyle(Color.amux.cinnabar)
                    }
                    .disabled(isSaving)

                    if let teamName {
                        Text(teamName)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Color.amux.basalt.opacity(0.75))
                            .lineLimit(1)
                    }
                }
                .padding(.top, 10)

                VStack(alignment: .leading, spacing: 8) {
                    Text("Display Name")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(0.6)
                        .foregroundStyle(Color.amux.basalt.opacity(0.7))
                    TextField("Your name", text: $displayName)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .font(.system(size: 16))
                        .foregroundStyle(Color.amux.onyx)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 11)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(Color.amux.paper)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                                        .stroke(Color.amux.hairline, lineWidth: 0.5)
                                )
                        )
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(Color.amux.cinnabarDeep)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
            .background(Color.amux.mist.ignoresSafeArea())
            .navigationTitle("Edit Profile")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving" : "Save") {
                        Task { await save() }
                    }
                    .disabled(!canSave)
                }
            }
            .onChange(of: selectedPhoto) { _, item in
                Task { await loadPhoto(item) }
            }
        }
    }

    @ViewBuilder
    private var avatarPreview: some View {
        if let selectedAvatarImage {
            Image(uiImage: selectedAvatarImage)
                .resizable()
                .scaledToFill()
                .frame(width: 86, height: 86)
                .clipShape(Circle())
        } else {
            ProfileAvatarView(
                displayName: trimmedName.isEmpty ? initialDisplayName : trimmedName,
                avatarURL: avatarURL,
                size: 86,
                fontSize: 30
            )
        }
    }

    @MainActor
    private func loadPhoto(_ item: PhotosPickerItem?) async {
        guard let item else { return }
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data),
                  let jpeg = image.jpegData(compressionQuality: 0.82) else {
                errorMessage = String(localized: "Could not load that image.")
                return
            }
            selectedAvatarImage = image
            selectedAvatarData = jpeg
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func save() async {
        guard canSave else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }

        do {
            guard let repo = actorRepository else {
                errorMessage = String(localized: "Cloud API is not configured.")
                return
            }
            var nextAvatarURL = avatarURL
            if let selectedAvatarData {
                nextAvatarURL = try await repo.uploadAvatar(
                    actorID: actorID,
                    imageData: selectedAvatarData,
                    contentType: "image/jpeg"
                )
            }
            let record = try await repo.updateCurrentActorProfile(
                actorID: actorID,
                displayName: trimmedName,
                avatarURL: nextAvatarURL
            )
            onSaved(record)
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct ProfileAvatarView: View {
    let displayName: String
    let avatarURL: String?
    let size: CGFloat
    let fontSize: CGFloat

    static func initials(for displayName: String) -> String {
        let parts = displayName
            .split(whereSeparator: { $0.isWhitespace })
            .compactMap { $0.first }
        return String(parts.prefix(2)).uppercased()
    }

    private var initials: String {
        Self.initials(for: displayName)
    }

    var body: some View {
        ZStack {
            Circle().fill(Color.amux.cinnabar)
            if let avatarURL, let url = URL(string: avatarURL) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        initialsText
                    }
                }
            } else {
                initialsText
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }

    private var initialsText: some View {
        Text(initials.isEmpty ? "·" : initials)
            .font(.system(size: fontSize, weight: .bold))
            .foregroundStyle(Color.amux.paper)
            .tracking(-0.4)
    }
}

// MARK: - Hai shared building blocks (file-private)

/// Paper card background tuned for the Mist Settings surface — soft
/// rounded edges with a faint hairline so cards still read against
/// Mist without a heavy shadow.
private struct SettingsCardBackground: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(Color.amux.paper)
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(Color.amux.hairline, lineWidth: 0.5)
            )
    }
}

/// Uppercased Basalt label that sits above each grouped Settings card,
/// matching the prototype's `SectionLabel` typography.
private struct SettingsSectionLabel: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View {
        Text(title.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(Color.amux.basalt.opacity(0.7))
            .padding(.horizontal, 24)
    }
}

/// Single key/value row used inside Settings cards — Onyx label on the
/// left, Basalt value on the right, monospaced when asked. Visual twin of
/// the prototype's `SheetRow` (without a chevron, since none of the rows
/// here drill into another screen yet).
private struct SettingsRow: View {
    let label: String
    let value: String
    let valueIsMonospaced: Bool
    init(label: String, value: String, valueIsMonospaced: Bool = false) {
        self.label = label
        self.value = value
        self.valueIsMonospaced = valueIsMonospaced
    }
    var body: some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 14.5))
                .foregroundStyle(Color.amux.onyx)
            Spacer(minLength: 8)
            Text(value)
                .font(.system(
                    size: 13.5,
                    design: valueIsMonospaced ? .monospaced : .default
                ))
                .foregroundStyle(Color.amux.basalt)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
    }
}
