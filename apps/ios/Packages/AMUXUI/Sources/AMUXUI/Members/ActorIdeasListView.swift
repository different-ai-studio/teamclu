import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Second-level destination from a person's detail screen: what they posted.
///
/// A distinct `Hashable` type for the same reason `ActorResourceRoute` is one
/// — the stack has to tell "push actor X" from "push actor X's ideas".
struct ActorIdeasRoute: Hashable {
    let actorID: String
    let actorName: String
    let teamID: String
}

/// The ideas behind the IDEAS number, in the same order and by the same rule.
///
/// Read-only, like the skills and MCP lists this sits beside. An idea does
/// have a detail screen, but it lives in the Ideas tab and wants a live
/// `IdeaStore`, an MQTT hub and a peer id — none of which the members tab
/// carries. Rows are therefore drawn flat, with no chevron and no tap, so
/// they do not promise a push that is not there.
struct ActorIdeasListView: View {
    let route: ActorIdeasRoute
    let repositories: MemberStatsRepositories?

    @State private var ideas: [IdeaRecord] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section {
                Text("Posted by \(route.actorName). Archived ideas are not counted.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            }

            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .font(.callout)
                        .foregroundStyle(Color.amux.cinnabarDeep)
                }
            } else if isLoading {
                Section { ProgressView().frame(maxWidth: .infinity) }
            } else if ideas.isEmpty {
                Section {
                    ContentUnavailableView(
                        "No ideas yet",
                        systemImage: IdeaUIPresentation.systemImage,
                        description: Text("\(route.actorName) hasn’t posted anything to the board.")
                    )
                }
            } else {
                Section { ForEach(ideas) { ActorIdeaRow(idea: $0) } }
            }
        }
        // Same reason as ActorResourceListView: List otherwise keeps the
        // system grouped canvas, which is cooler than the Hai paper of the
        // detail screen this is pushed from.
        .scrollContentBackground(.hidden)
        .background(Color.amux.mist)
        .navigationTitle(IdeaUIPresentation.pluralTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.amux.mist, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task { await load() }
    }

    private func load() async {
        guard let repositories else {
            isLoading = false
            errorMessage = String(localized: "Ideas need a signed-in Cloud API session.")
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let all = try await repositories.ideas.listIdeas(teamID: route.teamID)
            ideas = MemberActivityStatsLoader.ideas(in: all, by: route.actorID)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct ActorIdeaRow: View {
    let idea: IdeaRecord

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(idea.displayTitle)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
            if !idea.description.isEmpty {
                Text(idea.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            HStack(spacing: 10) {
                Text(idea.createdAt.formatted(date: .abbreviated, time: .omitted))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                // Only when there is something to report: a row of zeros on
                // every post reads as a broken counter rather than a quiet one.
                if idea.likeCount > 0 {
                    countLabel("heart", idea.likeCount)
                }
                if idea.commentCount > 0 {
                    countLabel("bubble.left", idea.commentCount)
                }
                if !idea.attachmentURLs.isEmpty {
                    countLabel("photo", idea.attachmentURLs.count)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func countLabel(_ symbol: String, _ count: Int) -> some View {
        HStack(spacing: 3) {
            Image(systemName: symbol)
            Text("\(count)").monospacedDigit()
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
    }
}
