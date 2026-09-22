import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI

public struct IdeaListView: View {
    @Bindable var ideaStore: IdeaStore

    @Query(filter: #Predicate<CachedActor> { $0.actorType == "member" },
           sort: \CachedActor.displayName)
    private var members: [CachedActor]

    @Query(sort: \Workspace.displayName) private var workspaces: [Workspace]

    private var memberById: [String: CachedActor] {
        Dictionary(uniqueKeysWithValues: members.map { ($0.actorId, $0) })
    }

    private var workspaceNameById: [String: String] {
        Dictionary(uniqueKeysWithValues: workspaces.map { ($0.workspaceId, $0.displayName) })
    }

    @Binding var showCreate: Bool
    @Binding var navigationPath: [String]
    @State private var showArchived = false

    /// Kept for callers and for future "only mine" affordances; the feed
    /// itself no longer slices by author.
    let currentActorID: String?

    public init(
        ideaStore: IdeaStore,
        showCreate: Binding<Bool>,
        navigationPath: Binding<[String]>,
        currentActorID: String? = nil
    ) {
        self.ideaStore = ideaStore
        self._showCreate = showCreate
        self._navigationPath = navigationPath
        self.currentActorID = currentActorID
    }

    /// Newest post first. The store's canonical order is the board's
    /// (`sort_order`, then most-recently-touched), which is what reordering
    /// and the desktop's columns are built on — a feed reads by when things
    /// were said, and a comment arriving should not bump a week-old post back
    /// to the top the way `updated_at` would.
    private var feedIdeas: [IdeaRecord] {
        ideaStore.ideas.sorted { lhs, rhs in
            if lhs.createdAt == rhs.createdAt { return lhs.id > rhs.id }
            return lhs.createdAt > rhs.createdAt
        }
    }

    private func authorName(for idea: IdeaRecord) -> String {
        memberById[idea.createdByActorID]?.displayName ?? String(localized: "Someone")
    }

    public var body: some View {
        VStack(spacing: 0) {
            if let errorMessage = ideaStore.errorMessage, ideaStore.ideas.isEmpty, !ideaStore.isLoading {
                ContentUnavailableView(
                    "Couldn’t Load Ideas",
                    systemImage: "exclamationmark.triangle",
                    description: Text(errorMessage)
                )
            } else if ideaStore.isLoading && ideaStore.ideas.isEmpty {
                ProgressView("Loading ideas…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if ideaStore.ideas.isEmpty {
                ContentUnavailableView(
                    "No Ideas",
                    systemImage: IdeaUIPresentation.systemImage,
                    description: Text("Tap + to create an idea")
                )
            } else {
                List {
                    // Anything that goes wrong after the first load — a like
                    // that didn't land, pictures the backend dropped — used
                    // to be written to `errorMessage` and never shown, because
                    // the only place that read it was the empty state.
                    if let errorMessage = ideaStore.errorMessage {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "exclamationmark.triangle")
                                .font(.system(size: 12))
                            Text(errorMessage)
                                .font(.footnote)
                            Spacer(minLength: 8)
                            Button {
                                ideaStore.errorMessage = nil
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 11, weight: .semibold))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Dismiss")
                        }
                        .foregroundStyle(Color.amux.cinnabarDeep)
                        .padding(.vertical, 10)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                    }
                    ForEach(feedIdeas) { item in
                        IdeaFeedCard(
                            item: item,
                            authorName: authorName(for: item),
                            onOpen: { navigationPath.append("idea:\(item.id)") },
                            onToggleLike: {
                                Task { await ideaStore.setLiked(ideaID: item.id, liked: !item.likedByMe) }
                            }
                        )
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                        .listRowSeparatorTint(Color.amux.hairline)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button {
                                Task { await ideaStore.setArchived(ideaID: item.id, archived: true) }
                            } label: {
                                Label("Archive", systemImage: "archivebox.fill")
                            }
                            .tint(.gray)
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .refreshable {
                    await ideaStore.reload()
                }
            }
        }
        .background(Color.amux.mist)
        .navigationTitle(IdeaUIPresentation.pluralTitle)
        .navigationBarTitleDisplayMode(.large)
        .safeAreaInset(edge: .bottom) {
            if !ideaStore.archivedIdeas.isEmpty {
                Button {
                    showArchived = true
                } label: {
                    HStack {
                        Image(systemName: "archivebox")
                        Text("Archived (\(ideaStore.archivedIdeas.count))")
                        Spacer()
                    }
                    .font(.body)
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .padding(.horizontal, 16)
                }
                .buttonStyle(.plain)
            }
        }
        .sheet(isPresented: $showCreate) {
            CreateIdeaSheet(ideaStore: ideaStore) { }
        }
        .sheet(isPresented: $showArchived) {
            ArchivedIdeasView(ideaStore: ideaStore)
        }
    }
}
