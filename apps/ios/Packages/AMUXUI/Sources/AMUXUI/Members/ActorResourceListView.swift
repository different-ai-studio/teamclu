import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Second-level destination from an actor's detail screen: the skills or MCP
/// servers that actor has installed, or the team's environment keys.
///
/// A distinct `Hashable` type rather than another `String` route, so the stack
/// can tell "push actor X" from "push actor X's skills".
struct ActorResourceRoute: Hashable {
    let actorID: String
    let actorName: String
    let teamID: String
    let kind: TeamResourceKind
}

extension TeamResourceKind {
    var title: String {
        switch self {
        case .skills: "Skills"
        case .mcp: "MCP"
        case .env: "Env"
        }
    }

    var symbol: String {
        switch self {
        case .skills: "sparkles"
        case .mcp: "powerplug"
        case .env: "key"
        }
    }
}

struct ActorResourceListView: View {
    let route: ActorResourceRoute
    let repository: (any TeamResourceRepository)?

    @State private var skills: [TeamSkillRecord] = []
    @State private var servers: [TeamMcpServerRecord] = []
    @State private var envKeys: [TeamEnvSecretRecord] = []
    @State private var isLoading = true
    @State private var errorMessage: String?

    var body: some View {
        List {
            if route.kind.isActorScoped {
                Section {
                    Text("Installed for \(route.actorName).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                }
            } else {
                Section {
                    // Env has no actor dimension — the same keys for everyone
                    // in the team. Saying so here is the counterpart to the
                    // "TEAM" tag on the stat block.
                    Text("Shared by the whole team. Values are encrypted and never leave the server in the clear.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .listRowBackground(Color.clear)
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .font(.callout)
                        .foregroundStyle(Color.amux.cinnabarDeep)
                }
            } else if isLoading {
                Section { ProgressView().frame(maxWidth: .infinity) }
            } else if isEmpty {
                Section {
                    ContentUnavailableView(
                        emptyTitle,
                        systemImage: route.kind.symbol,
                        description: Text(emptyDescription)
                    )
                }
            } else {
                Section { rows }
            }
        }
        // `List` otherwise keeps the system grouped canvas behind its rows,
        // which is noticeably cooler than the Hai paper used by the actor
        // detail it is pushed from. Hide that canvas so Skills, MCP, and Env
        // all inherit the same Mist ground.
        .scrollContentBackground(.hidden)
        .background(Color.amux.mist)
        .navigationTitle(route.kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color.amux.mist, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task { await load() }
    }

    @ViewBuilder
    private var rows: some View {
        switch route.kind {
        case .skills:
            ForEach(skills) { skill in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(skill.slug).fontWeight(.semibold)
                        if skill.hasUpdate {
                            Text("UPDATE")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(Color.amux.cinnabar)
                        }
                        Spacer(minLength: 4)
                        if let v = skill.installedVersion {
                            Text("v\(v)")
                                .font(.caption).monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                    }
                    if !skill.summary.isEmpty {
                        Text(skill.summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .padding(.vertical, 2)
            }
        case .mcp:
            ForEach(servers) { server in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(server.name).fontWeight(.semibold)
                        Spacer(minLength: 4)
                        Text(server.transport.uppercased())
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    // `local` runs a command, `remote` hits a URL — exactly one
                    // is populated, so show whichever it is.
                    if let detail = server.command ?? server.url, !detail.isEmpty {
                        Text(detail)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                .padding(.vertical, 2)
            }
        case .env:
            ForEach(envKeys) { key in
                HStack {
                    Text(key.keyId).font(.callout.monospaced())
                    Spacer(minLength: 8)
                    if let updated = key.updatedAt {
                        Text(updated, style: .date)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private var isEmpty: Bool {
        switch route.kind {
        case .skills: skills.isEmpty
        case .mcp: servers.isEmpty
        case .env: envKeys.isEmpty
        }
    }

    private var emptyTitle: String {
        switch route.kind {
        case .skills: "No skills installed"
        case .mcp: "No MCP servers installed"
        case .env: "No environment keys"
        }
    }

    private var emptyDescription: String {
        switch route.kind {
        case .skills, .mcp:
            "\(route.actorName) has nothing installed from the team catalog yet."
        case .env:
            "This team has not set any shared environment variables."
        }
    }

    private func load() async {
        guard let repository else {
            errorMessage = String(localized: "Not signed in to a team.")
            isLoading = false
            return
        }
        isLoading = true
        errorMessage = nil
        do {
            switch route.kind {
            case .skills:
                skills = try await repository
                    .listSkills(teamID: route.teamID, actorID: route.actorID)
                    .filter(\.installed)
            case .mcp:
                servers = try await repository
                    .listMcpServers(teamID: route.teamID, actorID: route.actorID)
                    .filter(\.installed)
            case .env:
                envKeys = try await repository.listEnvSecrets(teamID: route.teamID)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}
