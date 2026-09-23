import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

public struct ShortcutsDrawer: View {
    @Binding var isPresented: Bool
    @Bindable var store: ShortcutsStore
    let currentActorID: String?
    let activeTeam: TeamSummary?
    let onOpenSettings: () -> Void
    /// The team apps store, when the deployment has that feature and a
    /// repository could be built. nil hides the entry entirely — see
    /// `BootstrapFeatureFlags.apps`.
    let appsStore: TeamAppsStore?
    let onOpenApps: () -> Void

    @Query private var cachedActors: [CachedActor]
    @State private var expandedIDs: Set<String> = []
    @State private var presentedLink: ShortcutLinkPresentation?

    public init(isPresented: Binding<Bool>,
                store: ShortcutsStore,
                currentActorID: String? = nil,
                activeTeam: TeamSummary? = nil,
                onOpenSettings: @escaping () -> Void,
                appsStore: TeamAppsStore? = nil,
                onOpenApps: @escaping () -> Void = {}) {
        self._isPresented = isPresented
        self.store = store
        self.currentActorID = currentActorID
        self.activeTeam = activeTeam
        self.onOpenSettings = onOpenSettings
        self.appsStore = appsStore
        self.onOpenApps = onOpenApps
    }

    public var body: some View {
        GeometryReader { geometry in
            let drawerWidth = min(360, geometry.size.width * 0.86)
            ZStack(alignment: .leading) {
                if isPresented {
                    Color.amux.onyx
                        .opacity(0.22)
                        .ignoresSafeArea()
                        .onTapGesture { close() }
                        .transition(.opacity)

                    drawer(width: drawerWidth)
                        .transition(.move(edge: .leading))
                        .gesture(closeDrag)
                        .zIndex(1)
                }
            }
            .animation(.spring(response: 0.42, dampingFraction: 0.86), value: isPresented)
        }
        .fullScreenCover(item: $presentedLink) { link in
            ShortcutWebScreen(title: link.title, url: link.url) {
                presentedLink = nil
            }
        }
    }

    // MARK: - Drawer layout

    private func drawer(width: CGFloat) -> some View {
        VStack(spacing: 0) {
            profileHeader
            shortcutList
        }
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color.amux.mist)
        .ignoresSafeArea(edges: [.leading, .bottom])
    }

    // MARK: - Profile header

    private var currentActor: CachedActor? {
        guard let id = currentActorID else { return nil }
        return cachedActors.first(where: { $0.actorId == id })
    }

    private var profileDisplayName: String {
        if let name = currentActor?.displayName, !name.isEmpty { return name }
        return activeTeam?.name ?? "Signed out"
    }

    private var profileSubtitle: String? {
        if let role = currentActor?.roleLabel, role != "—" { return role }
        if let team = activeTeam?.name { return "Team · \(team)" }
        return nil
    }

    private var profileHeader: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                ProfileAvatarView(
                    displayName: profileDisplayName,
                    avatarURL: currentActor?.avatarURL,
                    size: 44,
                    fontSize: 16
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(profileDisplayName)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color.amux.onyx)
                        .lineLimit(1)

                    if let subtitle = profileSubtitle {
                        Text(subtitle)
                            .font(.system(size: 13))
                            .foregroundStyle(Color.amux.slate)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 6)

                settingsHeaderButton
            }
            .padding(.horizontal, 20)
            .padding(.top, 18)
            .padding(.bottom, 14)

            Rectangle()
                .fill(Color.amux.hairline)
                .frame(height: 0.5)
                .padding(.horizontal, 20)
        }
    }

    private var appVersion: String {
        let short = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
        return "v\(short)"
    }

    private var settingsHeaderButton: some View {
        Button(action: handleSettingsTap) {
            HStack(spacing: 6) {
                Image(systemName: "gearshape")
                    .font(.system(size: 14, weight: .regular))

                Text(appVersion)
                    .font(.system(size: 12, weight: .regular, design: .monospaced))

                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
            }
            .foregroundStyle(Color.amux.slate)
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(
                Capsule()
                    .fill(Color.amux.pebble.opacity(0.55))
            )
            .contentShape(Capsule())
        }
        .buttonStyle(SettingsRowButtonStyle())
        .accessibilityIdentifier("shortcuts.settingsButton")
        .accessibilityLabel("Settings")
    }

    // MARK: - List content

    private var shortcutList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                section(title: "Personal", scope: .personal)
                section(title: "Team", scope: .team)

                // Inline rather than as an overlay: the drawer now carries a
                // second kind of content below the shortcuts, and a full-size
                // overlay for "no shortcuts" would sit on top of it.
                if allRootNodesAreEmpty && !store.isLoading {
                    emptyState
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                }

                if let err = store.errorMessage {
                    Text(err)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.amux.slate)
                        .padding(.horizontal, 20)
                        .padding(.top, 4)
                }

                appsSection
            }
            .padding(.top, 16)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color.amux.mist)
        .refreshable {
            await store.reload()
        }
        .task {
            await store.reload()
        }
        .overlay {
            if store.isLoading && allRootNodesAreEmpty {
                ProgressView().tint(Color.amux.basalt)
            }
        }
    }

    // MARK: - Team apps

    /// Sits at the foot of the drawer, under both shortcut scopes. With no
    /// apps yet it is a pitch rather than an empty row — the one place in this
    /// client that asks for an app to exist.
    @ViewBuilder
    private var appsSection: some View {
        if let appsStore {
            VStack(alignment: .leading, spacing: 4) {
                Rectangle()
                    .fill(Color.amux.hairline)
                    .frame(height: 0.5)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 10)

                if appsStore.hasLoaded && appsStore.isEmpty {
                    appsPromo
                } else {
                    appsEntryRow(count: appsStore.apps.count)
                }
            }
            .task { await appsStore.reload() }
        }
    }

    private func appsEntryRow(count: Int) -> some View {
        Button(action: handleAppsTap) {
            HStack(spacing: 12) {
                Image(systemName: "square.grid.2x2")
                    .font(.system(size: 15))
                    .foregroundStyle(Color.amux.basalt)
                    .frame(width: 22)
                Text("团队应用")
                    .font(.system(size: 14.5))
                    .foregroundStyle(Color.amux.onyx)
                Spacer(minLength: 8)
                if count > 0 {
                    Text("\(count)")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Color.amux.slate)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.amux.slate)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(SettingsRowButtonStyle())
        .accessibilityIdentifier("shortcuts.appsButton")
    }

    private var appsPromo: some View {
        Button(action: handleAppsTap) {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Image(systemName: "square.grid.2x2")
                        .font(.system(size: 14))
                    Text("团队应用")
                        .font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(Color.amux.basalt)

                Text("创建你的第一个应用")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Color.amux.onyx)

                Text("给团队做一个小工具或页面，同事能直接打开，agent 也能帮你维护。")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Color.amux.slate)
                    .lineSpacing(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.amux.pebble.opacity(0.5))
            )
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("shortcuts.appsPromo")
    }

    /// Same dance as the settings entry: close first, present on the next tick
    /// so the sheet is not torn down with the drawer it was opened from.
    private func handleAppsTap() {
        close()
        DispatchQueue.main.async {
            onOpenApps()
        }
    }

    private func section(title: String, scope: ShortcutScope) -> some View {
        let roots = store.children(parentID: nil, scope: scope)
        return Group {
            if !roots.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    sectionHeader(title: title, count: roots.count)
                    VStack(spacing: 0) {
                        ForEach(roots) { node in
                            ShortcutMenuRow(
                                node: node,
                                store: store,
                                depth: 0,
                                expandedIDs: $expandedIDs,
                                onSelectLink: { url, title in
                                    presentedLink = ShortcutLinkPresentation(url: url, title: title)
                                }
                            )
                        }
                    }
                }
            }
        }
    }

    private func sectionHeader(title: String, count: Int) -> some View {
        Text("\(title.uppercased()) · \(count)")
            .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
            .tracking(0.4)
            .foregroundStyle(Color.amux.slate)
            .padding(.horizontal, 20)
            .padding(.bottom, 2)
    }

    // MARK: - Empty / loading state

    private var emptyState: some View {
        ContentUnavailableView(
            "No Shortcuts",
            systemImage: "star",
            description: Text("Shortcuts you or your team create will appear here.")
        )
        .foregroundStyle(Color.amux.basalt)
    }

    private var allRootNodesAreEmpty: Bool {
        store.children(parentID: nil, scope: .personal).isEmpty
            && store.children(parentID: nil, scope: .team).isEmpty
    }

    // MARK: - Gestures

    private var closeDrag: some Gesture {
        DragGesture(minimumDistance: 16)
            .onEnded { value in
                if value.translation.width < -56 || value.predictedEndTranslation.width < -120 {
                    close()
                }
            }
    }

    private func close() {
        isPresented = false
    }

    /// Close the drawer first, then ask the host to present SettingsView on the
    /// next runloop tick. Presenting the sheet from inside the drawer would
    /// tear it down on dismiss; routing through the host keeps the sheet alive
    /// even after the drawer animates away.
    private func handleSettingsTap() {
        close()
        DispatchQueue.main.async {
            onOpenSettings()
        }
    }
}

private struct SettingsRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.amux.onyx.opacity(0.04) : Color.clear)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct ShortcutLinkPresentation: Identifiable, Equatable {
    let id: String
    let url: URL
    let title: String

    init(url: URL, title: String) {
        self.id = url.absoluteString
        self.url = url
        self.title = title
    }
}
