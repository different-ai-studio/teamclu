import SwiftUI
import SwiftData
import AMUXCore

public struct SearchTab: View {
    let mqtt: MQTTService
    let pairing: PairingManager
    let teamcluService: TeamcluService?
    @Bindable var viewModel: SessionListViewModel
    @Binding var rootSelection: AppTab
    @Binding var sessionsPath: [String]

    @Environment(\.modelContext) private var modelContext
    @State private var query: String = ""

    @Query(filter: #Predicate<SessionIdea> { !$0.archived })
    private var allIdeas: [SessionIdea]

    @Query(filter: #Predicate<CachedActor> { $0.actorType == "member" },
           sort: \CachedActor.displayName)
    private var allMembers: [CachedActor]

    public init(mqtt: MQTTService,
                pairing: PairingManager,
                teamcluService: TeamcluService?,
                viewModel: SessionListViewModel,
                rootSelection: Binding<AppTab>,
                sessionsPath: Binding<[String]>) {
        self.mqtt = mqtt
        self.pairing = pairing
        self.teamcluService = teamcluService
        self.viewModel = viewModel
        self._rootSelection = rootSelection
        self._sessionsPath = sessionsPath
    }

    private var sessionMatches: [Session] {
        viewModel.sessions.filter { session in
            let attachment = liveAttachment(for: session)
            // `currentPrompt` / `lastOutputSummary` are gone: they were only
            // snapshotted on discrete lifecycle events and the actor retain
            // does not carry them (ADR-0004). Title and preview cover the same
            // ground and stay current.
            return SearchMatcher.matchesAny(
                fields: [
                    session.title,
                    session.lastMessagePreview,
                    attachment?.worktree ?? "",
                ],
                query: query
            )
        }
    }

    private var ideaMatches: [SessionIdea] {
        allIdeas.filter {
            SearchMatcher.matchesAny(
                fields: [$0.title, $0.ideaDescription],
                query: query
            )
        }
    }

    private var memberMatches: [CachedActor] {
        allMembers.filter {
            SearchMatcher.matches(haystack: $0.displayName, query: query)
        }
    }

    public var body: some View {
        NavigationStack {
            List {
                if query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    ContentUnavailableView("Search",
                        systemImage: "magnifyingglass",
                        description: Text("Search sessions, ideas, and members."))
                } else {
                    if !sessionMatches.isEmpty {
                        Section("Sessions") {
                            ForEach(sessionMatches, id: \.sessionId) { session in
                                let runtime = liveAttachment(for: session)
                                Button {
                                    rootSelection = .sessions
                                    sessionsPath.append("session:\(session.sessionId)")
                                } label: {
                                    AgentRowView(session: session, runtime: runtime)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if !ideaMatches.isEmpty {
                        Section("Ideas") {
                            ForEach(ideaMatches, id: \.ideaId) { item in
                                IdeaRow(item: item)
                            }
                        }
                    }

                    if !memberMatches.isEmpty {
                        Section("Members") {
                            ForEach(memberMatches, id: \.actorId) { member in
                                HStack {
                                    Text(member.displayName)
                                        .font(.body)
                                    Spacer()
                                    Text(member.roleLabel)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }

                    if sessionMatches.isEmpty && ideaMatches.isEmpty && memberMatches.isEmpty {
                        ContentUnavailableView.search(text: query)
                    }
                }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always))
        }
    }

    /// The attachment serving this session, if any. Resolves by session id —
    /// the old form compared a spawn id against `primaryAgentId`, two different
    /// id spaces, so it never matched.
    private func liveAttachment(for session: Session) -> AgentAttachment? {
        viewModel.attachments
            .filter { $0.sessionID == session.sessionId }
            .max(by: { ($0.lastEventTime ?? .distantPast) < ($1.lastEventTime ?? .distantPast) })
    }

}
