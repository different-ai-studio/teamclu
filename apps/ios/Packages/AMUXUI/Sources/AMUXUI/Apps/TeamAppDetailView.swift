import SwiftUI
import AMUXCore
import AMUXSharedUI

/// One app, read-only.
///
/// Everything this client can change about an app is on a desktop: deploying,
/// env vars, cron, access grants. What a phone is for is checking on it and
/// opening it, so the page answers "is it up, and where" and then gets out of
/// the way.
struct TeamAppDetailView: View {
    let app: TeamAppRecord
    @Bindable var store: TeamAppsStore
    let onOpenSession: (String) -> Void

    @Environment(\.openURL) private var openURL
    @State private var sessions: [TeamAppSessionRecord] = []
    @State private var loadedSessions = false
    /// The freshest copy, once a re-read lands. Deploy state is exactly the
    /// thing that has moved on since the list was fetched.
    @State private var latest: TeamAppRecord?

    private var current: TeamAppRecord { latest ?? app }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                if current.needsDesktopSetup { desktopHint }
                if let url = current.openableURL { openCard(url) }
                detailsCard
                sessionsSection
            }
            .padding(.vertical, 16)
        }
        .background(Color.amux.mist)
        .navigationTitle(current.name)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            latest = await store.refresh(appID: app.id)
            await loadSessions()
        }
        .refreshable {
            latest = await store.refresh(appID: app.id)
            loadedSessions = false
            await loadSessions()
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: current.type.symbolName)
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(Color.amux.basalt)

            VStack(alignment: .leading, spacing: 4) {
                Text(current.name)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Color.amux.onyx)
                HStack(spacing: 6) {
                    TeamAppStatusDot(kind: current.statusKind)
                    Text(current.statusLabel)
                        .font(.system(size: 13))
                        .foregroundStyle(Color.amux.basalt)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 24)
    }

    // MARK: - The half-built case

    /// Shown for an app whose code has not been written yet — the state every
    /// app created from this client starts in. Says where to finish rather
    /// than offering a button that would 409.
    private var desktopHint: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("还没初始化")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.amux.onyx)
            Text("这个应用还只有一条记录，代码要在电脑上写入。在电脑上打开 TeamClu，进入应用库选中它，就能完成初始化并部署。")
                .font(.system(size: 13.5))
                .foregroundStyle(Color.amux.basalt)
                .lineSpacing(3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color.amux.pebble.opacity(0.55))
        )
        .padding(.horizontal, 16)
    }

    // MARK: - Open

    private func openCard(_ url: URL) -> some View {
        Button { openURL(url) } label: {
            HStack(spacing: 10) {
                Image(systemName: "arrow.up.right.square")
                    .font(.system(size: 16))
                VStack(alignment: .leading, spacing: 2) {
                    Text("打开应用")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(Color.amux.onyx)
                    Text(url.absoluteString)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(Color.amux.slate)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
            }
            .foregroundStyle(Color.amux.cinnabar)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.amux.paper)
            )
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .accessibilityIdentifier("apps.openAppButton")
    }

    // MARK: - Details

    private var detailsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HaiSectionLabel("详情")
            HaiPaperCard {
                HaiSheetRow(label: "类型", value: current.type.label)
                divider
                HaiSheetRow(label: "可见范围", value: current.visibility.label)
                divider
                HaiSheetRow(label: "代码来源", value: current.sourceLabel)
                divider
                HaiSheetRow(label: "我的关系", value: current.relationship.label)
                divider
                HaiSheetRow(
                    label: "创建于",
                    value: current.createdAt.formatted(date: .abbreviated, time: .shortened),
                    valueIsMuted: true
                )
            }
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.amux.hairline)
            .frame(height: 0.5)
            .padding(.leading, 14)
    }

    // MARK: - Linked sessions

    private var sessionsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HaiSectionLabel("相关会话")
            if sessions.isEmpty {
                Text(loadedSessions ? "还没有会话关联到这个应用。" : "载入中…")
                    .font(.system(size: 13))
                    .foregroundStyle(Color.amux.slate)
                    .padding(.horizontal, 24)
            } else {
                HaiPaperCard {
                    ForEach(Array(sessions.enumerated()), id: \.element.id) { index, session in
                        Button { onOpenSession(session.id) } label: {
                            HaiSheetRow(
                                label: session.title.isEmpty ? "未命名会话" : session.title,
                                value: (session.lastMessageAt ?? session.updatedAt)
                                    .formatted(date: .abbreviated, time: .omitted),
                                valueIsMuted: true,
                                showsChevron: true
                            )
                        }
                        .buttonStyle(.plain)
                        if index < sessions.count - 1 { divider }
                    }
                }
            }
        }
    }

    private func loadSessions() async {
        guard !loadedSessions else { return }
        // A failure leaves the section empty rather than raising an error over
        // the whole page: the sessions list is context here, not the subject.
        sessions = (try? await store.sessions(forApp: app.id)) ?? []
        loadedSessions = true
    }
}
