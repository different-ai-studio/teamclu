import SwiftUI
import AMUXCore
import AMUXSharedUI

#if os(iOS)

/// Top-of-Sessions pill summarizing daemon reachability + broker host.
/// Spec: AMUX iOS handoff `sessions-list.jsx` — sage-tinted pill with a
/// breathing dot when online; muted Pebble fill when offline/connecting.
struct DaemonStatusBanner: View {
    let pairing: PairingManager
    let mqtt: MQTTService

    private var isOnline: Bool { mqtt.connectionState == .connected }
    private var isConnecting: Bool {
        mqtt.connectionState == .connecting || mqtt.connectionState == .reconnecting
    }

    private var label: String {
        if isOnline { return "daemon online" }
        if isConnecting { return "daemon connecting" }
        return "daemon offline"
    }

    private var dotColor: Color {
        isOnline ? Color.amux.sage : Color.amux.slate
    }

    private var labelColor: Color {
        isOnline ? Color.amux.sage : Color.amux.basalt
    }

    private var backgroundColor: Color {
        isOnline
            ? Color.amux.sage.opacity(0.12)
            : Color.amux.pebble.opacity(0.45)
    }

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)
                .breathingOpacity(active: isOnline)
            Text(label)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(labelColor)
            if !pairing.brokerHost.isEmpty {
                Text(pairing.brokerHost)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(Color.amux.basalt.opacity(0.75))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(backgroundColor)
        )
    }
}

/// Inline search field for the Sessions list. Mirrors the iOS UIKit search
/// bar metrics from the handoff (`sessions-list.jsx`) so it reads at the
/// same density as a native search bar without the `.searchable` pull-down
/// gesture, which conflicted with the daemon banner pinned above.
struct SessionListSearchField: View {
    @Binding var text: String
    /// Owned by the list so it can dismiss the keyboard on scroll / outside tap.
    @FocusState.Binding var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(Color.amux.basalt.opacity(0.6))
            TextField("Search sessions", text: $text)
                .focused($isFocused)
                .font(.system(size: 17))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Color.amux.slate)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.amux.basalt.opacity(0.10))
        )
    }
}

#endif
