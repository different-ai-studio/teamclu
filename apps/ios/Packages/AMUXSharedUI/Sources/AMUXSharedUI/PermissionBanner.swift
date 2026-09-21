import SwiftUI
import AMUXCore

public struct PermissionBannerView: View {
    let toolName: String
    let description: String
    let requestId: String
    let isResolved: Bool
    let wasGranted: Bool?
    /// ACP options for this request. Empty renders the legacy binary
    /// Allow/Deny pair; otherwise one button per option, so multi-choice
    /// requests (allow once / always allow / reject) are actually
    /// selectable instead of collapsing to a binary.
    let options: [PermissionOptionItem]
    let onSelect: ((PermissionOptionItem) -> Void)?
    let onGrant: ((String) -> Void)?
    let onDeny: ((String) -> Void)?

    public init(toolName: String, description: String, requestId: String,
                isResolved: Bool = false, wasGranted: Bool? = nil,
                options: [PermissionOptionItem] = [],
                onSelect: ((PermissionOptionItem) -> Void)? = nil,
                onGrant: ((String) -> Void)?, onDeny: ((String) -> Void)?) {
        self.toolName = toolName; self.description = description; self.requestId = requestId
        self.isResolved = isResolved; self.wasGranted = wasGranted
        self.options = options; self.onSelect = onSelect
        self.onGrant = onGrant; self.onDeny = onDeny
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                // Cinnabar shield in place of the iOS-orange lock — the
                // permission banner is the canonical "intent moment" where
                // the design language allows the vermillion seal.
                Image(systemName: "lock.shield").foregroundStyle(Color.amux.cinnabar)
                Text("Permission Request").font(.subheadline).fontWeight(.semibold)
                    .foregroundStyle(Color.amux.onyx)
            }
            Text("\(toolName): \(description)")
                .font(.caption)
                .foregroundStyle(Color.amux.basalt)

            if isResolved {
                HStack(spacing: 6) {
                    Image(systemName: wasGranted == true ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(wasGranted == true ? Color.amux.sage : Color.amux.cinnabarDeep)
                    Text(wasGranted == true ? "Allowed" : "Denied")
                        .font(.subheadline).fontWeight(.medium)
                        .foregroundStyle(wasGranted == true ? Color.amux.sage : Color.amux.cinnabarDeep)
                }
            } else if !options.isEmpty, let onSelect {
                // Allow variants lead, reject sits last — matches the
                // order agents send and keeps the destructive choice at
                // the end of the scan path.
                let allows = options.filter { !$0.isReject }
                let rejects = options.filter { $0.isReject }
                VStack(spacing: 8) {
                    HStack(spacing: 12) {
                        ForEach(allows) { option in
                            optionButton(option, action: onSelect)
                        }
                    }
                    if !rejects.isEmpty {
                        HStack(spacing: 12) {
                            ForEach(rejects) { option in
                                optionButton(option, action: onSelect)
                            }
                        }
                    }
                }
            } else {
                HStack(spacing: 12) {
                    Button { onDeny?(requestId) } label: {
                        Text("Deny").font(.subheadline).fontWeight(.medium).frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                            .background(Color.amux.cinnabarDeep.opacity(0.10), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    Button { onGrant?(requestId) } label: {
                        Text("Allow").font(.subheadline).fontWeight(.medium).frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                            .foregroundStyle(Color.amux.sage)
                            .background(Color.amux.sage.opacity(0.18), in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        // One width whatever the request says. Without this the card is sized
        // by its contents, so a short description or the resolved state (a
        // check and one word, with none of the full-width buttons) shrinks the
        // card and the feed gains a ragged edge.
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.amux.cinnabar.opacity(0.30), lineWidth: 1)
        )
    }

    @ViewBuilder
    private func optionButton(_ option: PermissionOptionItem,
                              action: @escaping (PermissionOptionItem) -> Void) -> some View {
        let tint = option.isReject ? Color.amux.cinnabarDeep : Color.amux.sage
        Button { action(option) } label: {
            Text(option.name.isEmpty ? option.id : option.name)
                .font(.subheadline).fontWeight(.medium)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
                .foregroundStyle(tint)
                .background(tint.opacity(option.isReject ? 0.10 : 0.18), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("permission.option.\(option.id)")
    }
}
