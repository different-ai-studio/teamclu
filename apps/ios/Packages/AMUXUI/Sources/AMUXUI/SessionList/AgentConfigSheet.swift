import SwiftUI
import AMUXCore

public struct AgentConfigSheet: View {
    public struct Selection: Equatable, Sendable {
        public var workspaceID: String
        public var agentType: AgentType
    }

    public enum AgentType: String, CaseIterable, Identifiable, Sendable {
        /// pi is the only runtime the daemon runs (#1247); the legacy cases
        /// stay so old stored values still parse, and the daemon reroutes them.
        case pi
        case claude = "claude"
        case opencode, codex
        public var id: String { rawValue }
        public var label: String {
            switch self {
            case .pi: "Pi"
            case .claude: "Claude"
            case .opencode: "OpenCode"
            case .codex: "Codex"
            }
        }

        public static func fromStoredValue(_ value: String?) -> AgentType {
            switch value {
            case "claude", "claude_code", "claude-code": .claude
            case "opencode": .opencode
            case "codex": .codex
            default: .pi
            }
        }

        public static func supported(from values: [String]) -> [AgentType] {
            values.map { fromStoredValue($0) }.reduce(into: []) { result, type in
                if !result.contains(type) { result.append(type) }
            }
        }
    }

    let actorDisplayName: String
    let workspaces: [WorkspaceRef]
    let allowedTypes: [AgentType]
    let onConfirm: (Selection) -> Void
    let onCancel: () -> Void

    @State private var selectedWorkspaceID: String
    @State private var selectedType: AgentType = .pi

    public init(actorDisplayName: String,
                workspaces: [WorkspaceRef],
                defaultType: AgentType = .pi,
                allowedTypes: [AgentType] = [.pi],
                onConfirm: @escaping (Selection) -> Void,
                onCancel: @escaping () -> Void) {
        self.actorDisplayName = actorDisplayName
        self.workspaces = workspaces
        let usableTypes = allowedTypes.isEmpty ? [.pi] : allowedTypes
        self.allowedTypes = usableTypes
        self.onConfirm = onConfirm
        self.onCancel = onCancel
        _selectedWorkspaceID = State(initialValue: workspaces.first?.id ?? "")
        _selectedType = State(initialValue: usableTypes.contains(defaultType) ? defaultType : (usableTypes.first ?? .pi))
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section("Workspace") {
                    Picker("Workspace", selection: $selectedWorkspaceID) {
                        ForEach(workspaces, id: \.id) { ws in
                            Text(ws.path).tag(ws.id)
                        }
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                }
                Section("Agent type") {
                    Picker("", selection: $selectedType) {
                        ForEach(allowedTypes) { t in Text(t.label).tag(t) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                }
            }
            .navigationTitle("Configure \(actorDisplayName)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onCancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") {
                        onConfirm(Selection(workspaceID: selectedWorkspaceID, agentType: selectedType))
                    }
                    .disabled(selectedWorkspaceID.isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

public struct WorkspaceRef: Equatable, Hashable {
    public let id: String
    public let path: String
    public init(id: String, path: String) { self.id = id; self.path = path }
}

// MARK: - AgentConfigSheet.AgentType → Amux_AgentType

extension AgentConfigSheet.AgentType {
    /// Maps the UI-facing agent type enum to the proto enum used by
    /// daemon RPC + persistence. Lives next to the source enum so both
    /// NewSessionSheet and AddAgentSheet share one mapping.
    var asAmuxAgentType: Amux_AgentType {
        switch self {
        case .pi:        return .pi
        case .claude:    return .claudeCode
        case .opencode:  return .opencode
        case .codex:     return .codex
        }
    }
}

#Preview("Single workspace") {
    AgentConfigSheet(
        actorDisplayName: "mini",
        workspaces: [WorkspaceRef(id: "w1", path: "/Volumes/openbeta/workspace/teamclu-v2")],
        onConfirm: { _ in },
        onCancel: {}
    )
}
