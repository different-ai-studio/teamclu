import SwiftUI
import AMUXSharedUI

// The three intro-card pictures. DESIGN.md rules out hand-drawn illustration,
// so each one is a miniature of the app's own UI language instead — paper
// cards, hairlines, mono initials, agent badges, the breathing status dot —
// built from the theme tokens. No shadows, 2–6px radii, one touch of cinnabar.

/// Card 1 — teammates and an agent in one conversation; the agent's part is done.
struct SharedSessionIllustration: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            IntroMessageRow(speaker: .member("LM"), lines: [148, 92])
            IntroMessageRow(speaker: .agent, lines: [176, 150, 64], done: true)
            IntroMessageRow(speaker: .member("QY"), lines: [112], unread: true)
        }
        .padding(20)
        .frame(width: 292, alignment: .leading)
        .introPaper()
    }
}

/// Card 2 — what the team keeps (knowledge, skills, keys, memory), shared
/// with every member and agent.
struct TeamKnowledgeIllustration: View {
    // Satellites around the ledger, as offsets from its centre.
    private let nodes: [(IntroSpeaker, CGSize)] = [
        (.member("LM"), CGSize(width: -128, height: -70)),
        (.agent, CGSize(width: 118, height: -76)),
        (.agent, CGSize(width: -122, height: 70)),
        (.member("QY"), CGSize(width: 128, height: 66)),
    ]

    var body: some View {
        ZStack {
            // Dashed hairlines from each satellite into the ledger.
            Canvas { context, size in
                let c = CGPoint(x: size.width / 2, y: size.height / 2)
                var path = Path()
                for (_, off) in nodes {
                    path.move(to: CGPoint(x: c.x + off.width * 0.80, y: c.y + off.height * 0.80))
                    path.addLine(to: CGPoint(x: c.x + off.width * 0.56, y: c.y + off.height * 0.56))
                }
                context.stroke(path, with: .color(Color.amux.slate.opacity(0.8)),
                               style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
            }

            ledger

            ForEach(nodes.indices, id: \.self) { i in
                IntroSpeakerMark(speaker: nodes[i].0)
                    .offset(nodes[i].1)
            }
        }
        .frame(width: 320, height: 240)
    }

    private var ledger: some View {
        VStack(spacing: 0) {
            ledgerRow("KNOWLEDGE") { IntroMonoLabel("12") }
            Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
            ledgerRow("SKILLS") { IntroMonoLabel("5") }
            Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
            ledgerRow("KEYS") { IntroMonoLabel("••••") }
            Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
            ledgerRow("MEMORY") { IntroStatusDot(color: Color.amux.sage, breathes: false) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
        .frame(width: 150)
        .introPaper()
    }

    private func ledgerRow(_ label: String, @ViewBuilder trailing: () -> some View) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .tracking(1.8)
                .foregroundStyle(Color.amux.onyx)
            Spacer(minLength: 8)
            trailing()
        }
        .frame(height: 30)
    }
}

/// Card 3 — a workflow run once becomes an app anyone can open again.
struct WorkflowToAppIllustration: View {
    var body: some View {
        HStack(spacing: 14) {
            steps
            Image(systemName: "arrow.right")
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(Color.amux.slate)
            app
        }
        .frame(width: 320, height: 240)
    }

    private let stepWidths: [CGFloat] = [70, 52, 80]

    private var steps: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(stepWidths.indices, id: \.self) { i in
                HStack(spacing: 8) {
                    Text("\(i + 1)")
                        .font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundStyle(Color.amux.slate)
                    IntroTextLine(width: stepWidths[i], strong: i == 0)
                }
            }
        }
        .padding(14)
        .frame(width: 128, alignment: .leading)
        .introPaper()
    }

    private var app: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .fill(Color.amux.onyx.opacity(0.85))
                    .frame(width: 14, height: 14)
                IntroMonoLabel("APP")
            }
            IntroTextLine(width: 72, strong: true)
            IntroTextLine(width: 56)
            Text("RUN")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .tracking(1.8)
                .foregroundStyle(Color.amux.mist)
                .frame(maxWidth: .infinity)
                .frame(height: 24)
                .background(
                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                        .fill(Color.amux.cinnabar)
                )
                .padding(.top, 4)
        }
        .padding(14)
        .frame(width: 118, alignment: .leading)
        .introPaper()
    }
}

// MARK: - Pieces

enum IntroSpeaker {
    case member(String)
    case agent
}

private struct IntroMessageRow: View {
    let speaker: IntroSpeaker
    let lines: [CGFloat]
    var working = false
    var done = false
    var unread = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            IntroSpeakerMark(speaker: speaker)
            VStack(alignment: .leading, spacing: 7) {
                ForEach(lines.indices, id: \.self) { i in
                    IntroTextLine(width: lines[i], strong: i == 0)
                }
                if working {
                    HStack(spacing: 6) {
                        IntroStatusDot(color: Color.amux.sage, breathes: true)
                        IntroMonoLabel("WORKING")
                    }
                    .padding(.top, 2)
                }
                if done {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(Color.amux.sage)
                        IntroMonoLabel("DONE")
                    }
                    .padding(.top, 2)
                }
            }
            .padding(.top, 8)
            Spacer(minLength: 0)
            if unread {
                IntroStatusDot(color: Color.amux.cinnabar, breathes: false)
                    .padding(.top, 8)
            }
        }
    }
}

private struct IntroSpeakerMark: View {
    let speaker: IntroSpeaker

    var body: some View {
        switch speaker {
        case .member(let initials):
            Text(initials)
                .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                .foregroundStyle(Color.amux.basalt)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.amux.pebble))
        case .agent:
            HStack(spacing: 4) {
                Circle().fill(Color.amux.sage).frame(width: 5, height: 5)
                Text("AGENT")
                    .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                    .tracking(1)
                    .foregroundStyle(Color.amux.sage)
            }
            .padding(.horizontal, 7)
            .frame(height: 22)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color.amux.sage.opacity(0.14))
            )
        }
    }
}

private struct IntroTextLine: View {
    let width: CGFloat
    var strong = false

    var body: some View {
        Capsule()
            .fill(strong ? Color.amux.basalt.opacity(0.42) : Color.amux.slate.opacity(0.32))
            .frame(width: width, height: 5)
    }
}

private struct IntroMonoLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .medium, design: .monospaced))
            .tracking(1.8)
            .foregroundStyle(Color.amux.slate)
    }
}

/// 8px semantic dot; the active one breathes (DESIGN.md: 1.4s, 1 → 0.45).
private struct IntroStatusDot: View {
    let color: Color
    let breathes: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .opacity(dim ? 0.45 : 1)
            .onAppear {
                guard breathes, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) {
                    dim = true
                }
            }
    }
}

private extension View {
    func introPaper() -> some View {
        background(Color.amux.paper)
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .stroke(Color.amux.hairline, lineWidth: 0.5)
            )
    }
}
