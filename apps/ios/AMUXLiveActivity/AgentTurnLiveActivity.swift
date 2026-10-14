// apps/ios/AMUXLiveActivity/AgentTurnLiveActivity.swift
import ActivityKit
import SwiftUI
import WidgetKit
import AMUXSharedUI

/// An agent's turn on the lock screen and in the Dynamic Island: who is
/// working on what, whether it is waiting on you, and its latest line.
/// Colours follow the session list's dot — sage running, cinnabar waiting.
struct AgentTurnLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: AgentTurnAttributes.self) { context in
            // System background and primary/secondary text: the lock screen
            // renders this over the wallpaper in light and dark alike, and a
            // fixed paper tint washed the text out. Colour marks state only.
            LockScreenView(attributes: context.attributes, state: context.state, isStale: context.isStale)
                .widgetURL(context.attributes.sessionURL)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    PhaseDot(phase: context.state.phase)
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.updatedAt, style: .relative)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: 64, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.agentName)
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(PhaseText.label(context.state.phase, isStale: context.isStale))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(PhaseDot.color(context.state.phase))
                        if !context.state.line.isEmpty {
                            Text(context.state.line)
                                .font(.caption)
                                .lineLimit(2)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                PhaseDot(phase: context.state.phase)
            } compactTrailing: {
                Text(PhaseText.short(context.state.phase))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(PhaseDot.color(context.state.phase))
            } minimal: {
                PhaseDot(phase: context.state.phase)
            }
            .widgetURL(context.attributes.sessionURL)
            .keylineTint(PhaseDot.color(context.state.phase))
        }
    }
}

private struct LockScreenView: View {
    let attributes: AgentTurnAttributes
    let state: AgentTurnAttributes.ContentState
    let isStale: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                PhaseDot(phase: state.phase)
                Text(attributes.agentName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(PhaseText.label(state.phase, isStale: isStale))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(PhaseDot.color(state.phase))
                Spacer(minLength: 4)
                Text(state.updatedAt, style: .relative)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text(attributes.sessionTitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if !state.line.isEmpty {
                Text(state.line)
                    .font(.footnote)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
            }
        }
        .padding(16)
    }
}

private struct PhaseDot: View {
    let phase: AgentTurnAttributes.ContentState.Phase

    static func color(_ phase: AgentTurnAttributes.ContentState.Phase) -> Color {
        switch phase {
        case .running: Color.amux.sage
        case .waitingApproval: Color.amux.cinnabar
        case .done: Color.amux.sage
        }
    }

    var body: some View {
        Group {
            if phase == .done {
                Image(systemName: "checkmark.circle.fill")
                    .font(.caption)
            } else {
                Circle().frame(width: 8, height: 8)
            }
        }
        .foregroundStyle(Self.color(phase))
    }
}

private enum PhaseText {
    static func label(_ phase: AgentTurnAttributes.ContentState.Phase, isStale: Bool) -> String {
        switch phase {
        case .running: isStale ? String(localized: "No recent updates") : String(localized: "Working")
        case .waitingApproval: String(localized: "Needs your approval")
        case .done: String(localized: "Done")
        }
    }

    static func short(_ phase: AgentTurnAttributes.ContentState.Phase) -> String {
        switch phase {
        case .running: String(localized: "Working")
        case .waitingApproval: String(localized: "Approve")
        case .done: String(localized: "Done")
        }
    }
}
