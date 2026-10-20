import SwiftUI
import AMUXCore
import AMUXSharedUI

/// The team apps list, presented as a sheet from the shortcuts drawer.
///
/// It owns its own `NavigationStack` because the drawer is a sibling overlay
/// of the Sessions stack, not a view inside it — the drawer cannot push, so
/// the pages it opens bring their own stack. Settings is presented the same
/// way, for the same reason.
public struct TeamAppsView: View {
    @Bindable var store: TeamAppsStore
    let onOpenSession: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var filter: TeamAppRelationship?
    @State private var showNewApp = false

    public init(store: TeamAppsStore, onOpenSession: @escaping (String) -> Void) {
        self.store = store
        self.onOpenSession = onOpenSession
    }

    public var body: some View {
        NavigationStack {
            content
                .background(Color.amux.mist)
                .navigationTitle("团队应用")
                .navigationBarTitleDisplayMode(.large)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button("关闭") { dismiss() }
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.amux.basalt)
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button { showNewApp = true } label: {
                            Image(systemName: "plus")
                                .font(.title3)
                                .foregroundStyle(Color.amux.cinnabar)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("新建应用")
                        .accessibilityIdentifier("apps.newAppButton")
                    }
                }
                .navigationDestination(for: TeamAppRecord.self) { app in
                    TeamAppDetailView(app: app, store: store, onOpenSession: onOpenSession)
                }
        }
        .sheet(isPresented: $showNewApp) {
            NewTeamAppSheet(store: store)
        }
        .task { await store.reload() }
    }

    @ViewBuilder
    private var content: some View {
        if store.apps.isEmpty {
            // `hasLoaded` keeps the promo from flashing before the first
            // answer — an empty list and a not-yet-loaded list look the same
            // in the model, and only one of them is worth a full-page pitch.
            if store.hasLoaded {
                emptyState
            } else {
                ProgressView().tint(Color.amux.basalt)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else {
            list
        }
    }

    // MARK: - List

    private var visibleApps: [TeamAppRecord] { store.apps(matching: filter) }

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                filterChips
                VStack(spacing: 0) {
                    ForEach(Array(visibleApps.enumerated()), id: \.element.id) { index, app in
                        NavigationLink(value: app) {
                            TeamAppRow(app: app)
                        }
                        .buttonStyle(.plain)
                        if index < visibleApps.count - 1 {
                            Rectangle()
                                .fill(Color.amux.hairline)
                                .frame(height: 0.5)
                                .padding(.leading, 56)
                        }
                    }
                }
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color.amux.paper)
                )
                .padding(.horizontal, 16)

                if visibleApps.isEmpty {
                    Text("这个筛选下还没有应用。")
                        .font(.system(size: 13))
                        .foregroundStyle(Color.amux.slate)
                        .padding(.horizontal, 24)
                }

                if let err = store.errorMessage {
                    Text(err)
                        .font(.system(size: 12))
                        .foregroundStyle(Color.amux.cinnabarDeep)
                        .padding(.horizontal, 24)
                }
            }
            .padding(.vertical, 12)
        }
        .refreshable { await store.reload() }
    }

    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(label: "全部", value: nil)
                ForEach(TeamAppRelationship.allCases, id: \.self) { rel in
                    chip(label: rel.label, value: rel)
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func chip(label: String, value: TeamAppRelationship?) -> some View {
        let selected = filter == value
        return Button { filter = value } label: {
            Text(label)
                .font(.system(size: 12.5))
                .foregroundStyle(selected ? Color.amux.onyx : Color.amux.basalt)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    Capsule().fill(selected ? Color.amux.pebble : Color.amux.pebble.opacity(0.4))
                )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Empty state

    /// The pitch that stands where the list would be. Not a
    /// `ContentUnavailableView`: this one is asking for something, so it gets
    /// a verb the user can press rather than a shrug.
    private var emptyState: some View {
        VStack(spacing: 18) {
            Image(systemName: "square.grid.2x2")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(Color.amux.slate)

            VStack(spacing: 8) {
                Text("还没有团队应用")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(Color.amux.onyx)

                Text("应用是团队一起用的小工具或页面，建好之后可以分享给同事，也能让 agent 直接维护它。")
                    .font(.system(size: 14))
                    .foregroundStyle(Color.amux.basalt)
                    .multilineTextAlignment(.center)
                    .lineSpacing(3)
            }

            Button { showNewApp = true } label: {
                Text("创建你的第一个应用")
                    .font(.system(size: 15, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
            }
            .glassProminentButtonStyle()
            .tint(Color.amux.cinnabar)
            .accessibilityIdentifier("apps.createFirstAppButton")

            if let err = store.errorMessage {
                Text(err)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.amux.cinnabarDeep)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Row

private struct TeamAppRow: View {
    let app: TeamAppRecord

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: app.type.symbolName)
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(Color.amux.basalt)
                .frame(width: 28)

            VStack(alignment: .leading, spacing: 3) {
                Text(app.name)
                    .font(.system(size: 15.5))
                    .foregroundStyle(Color.amux.onyx)
                    .lineLimit(1)

                HStack(spacing: 6) {
                    TeamAppStatusDot(kind: app.statusKind)
                    Text(app.statusLabel)
                        .font(.system(size: 12.5))
                        .foregroundStyle(Color.amux.slate)
                    Text("·")
                        .font(.system(size: 12.5))
                        .foregroundStyle(Color.amux.slate)
                    Text(app.type.label)
                        .font(.system(size: 12.5))
                        .foregroundStyle(Color.amux.slate)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.amux.slate)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}
