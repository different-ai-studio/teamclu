import SwiftUI
import SwiftData
import AMUXCore

/// The ideas list, pushed onto the root session stack from the top-right
/// menu. It has no NavigationStack of its own: an idea opens as `"idea:<id>"`
/// on the shared path, which `SessionsHome` resolves, so a session started
/// from an idea pushes on top of it like any other.
struct IdeasScreen: View {
    let activeTeam: TeamSummary?
    /// Owned by `RootView`, so the idea detail resolved by the root stack
    /// reads the same store this list does.
    let ideaStore: IdeaStore?
    /// Drives the "Mine" filter on the ideas list — compared against
    /// `IdeaRecord.createdByActorID`. `nil` hides the chip.
    let currentActorID: String?
    @Binding var navigationPath: [String]

    @Query(sort: \CachedActor.displayName) private var actors: [CachedActor]
    @Query(sort: \Workspace.displayName)   private var workspaces: [Workspace]

    @State private var showCreate = false
    @State private var showStats = false

    var body: some View {
        content
            .navigationTitle(IdeaUIPresentation.pluralTitle)
            .navigationBarTitleDisplayMode(.large)
            .toolbar {
                if ideaStore != nil {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button { showStats = true } label: {
                            Image(systemName: "chart.bar.xaxis")
                                .font(.title3)
                                .foregroundStyle(.primary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Idea Statistics")
                        .accessibilityIdentifier("ideas.statsButton")
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button { showCreate = true } label: {
                            Image(systemName: "plus").font(.title3).foregroundStyle(.primary)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .sheet(isPresented: $showStats) {
                if let ideaStore {
                    IdeaStatsSheet(
                        ideas: ideaStore.ideas,
                        archivedIdeas: ideaStore.archivedIdeas,
                        actors: actors,
                        workspaces: workspaces
                    )
                }
            }
            .task { await ideaStore?.reload() }
    }

    @ViewBuilder
    private var content: some View {
        if activeTeam == nil {
            ContentUnavailableView(
                "No Team Selected",
                systemImage: "person.3",
                description: Text("Create or join a team to manage ideas.")
            )
        } else if let ideaStore {
            IdeaListView(
                ideaStore: ideaStore,
                showCreate: $showCreate,
                navigationPath: $navigationPath,
                currentActorID: currentActorID
            )
        } else {
            ProgressView("Loading ideas…")
        }
    }
}
