import SwiftUI
import AMUXSharedUI

// The three intro-card pictures. DESIGN.md rules out hand-drawn illustration,
// so each one is a miniature of the app's own UI language instead — paper
// cards, hairlines, mono initials, agent badges, the breathing status dot —
// built from the theme tokens. No shadows, 2–6px radii, one touch of cinnabar.

/// Card 1 — teammates and an agent in one conversation.
struct SharedSessionIllustration: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            IntroMessageRow(speaker: .member("LM"), lines: [148, 92])
            IntroMessageRow(speaker: .agent, lines: [176, 150, 64], working: true)
            IntroMessageRow(speaker: .member("QY"), lines: [112], unread: true)
        }
        .padding(20)
        .frame(width: 292, alignment: .leading)
        .introPaper()
    }
}

/// Card 2 — one body of knowledge, shared with every member and agent.
struct TeamKnowledgeIllustration: View {
    // Satellites around the document stack, as offsets from its centre.
    private let nodes: [(IntroSpeaker, CGSize)] = [
        (.member("LM"), CGSize(width: -118, height: -64)),
        (.agent, CGSize(width: 112, height: -70)),
        (.agent, CGSize(width: -112, height: 62)),
        (.member("QY"), CGSize(width: 118, height: 58)),
    ]

    var body: some View {
        ZStack {
            // Dashed hairlines from each satellite into the stack.
            Canvas { context, size in
                let c = CGPoint(x: size.width / 2, y: size.height / 2)
                var path = Path()
                for (_, off) in nodes {
                    path.move(to: CGPoint(x: c.x + off.width * 0.78, y: c.y + off.height * 0.78))
                    path.addLine(to: CGPoint(x: c.x + off.width * 0.46, y: c.y + off.height * 0.46))
                }
                context.stroke(path, with: .color(Color.amux.slate.opacity(0.8)),
                               style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
            }

            ZStack {
                IntroSheet(showsTitle: false).offset(x: -10, y: 10)
                IntroSheet(showsTitle: false).offset(x: -5, y: 5)
                IntroSheet(showsTitle: true)
            }

            ForEach(nodes.indices, id: \.self) { i in
                IntroSpeakerMark(speaker: nodes[i].0)
                    .offset(nodes[i].1)
            }

            HStack(spacing: 6) {
                IntroStatusDot(color: Color.amux.sage, breathes: false)
                IntroMonoLabel("SYNCED")
            }
            .offset(y: 108)
        }
        .frame(width: 320, height: 240)
    }
}

/// Card 3 — the agent works on the computer; the phone gets the one decision.
struct DesktopPhoneIllustration: View {
    var body: some View {
        ZStack {
            laptop.offset(x: -26, y: -6)
            phone.offset(x: 104, y: 36)
        }
        .frame(width: 320, height: 240)
    }

    private var laptop: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 11) {
                HStack(spacing: 5) {
                    ForEach(0..<3, id: \.self) { _ in
                        Circle().fill(Color.amux.pebble).frame(width: 6, height: 6)
                    }
                }
                .padding(.bottom, 4)
                IntroTextLine(width: 150, strong: true)
                IntroTextLine(width: 120)
                IntroTextLine(width: 164)
                IntroTextLine(width: 96)
                HStack(spacing: 6) {
                    IntroStatusDot(color: Color.amux.sage, breathes: true)
                    IntroMonoLabel("RUNNING")
                }
                .padding(.top, 4)
            }
            .padding(16)
            .frame(width: 232, height: 158, alignment: .topLeading)
            .introPaper()

            Capsule()
                .fill(Color.amux.pebble)
                .frame(width: 262, height: 6)
                .padding(.top, 3)
        }
    }

    private var phone: some View {
        VStack(alignment: .leading, spacing: 9) {
            Capsule()
                .fill(Color.amux.onyx.opacity(0.85))
                .frame(width: 22, height: 5)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 6)

            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 5) {
                    IntroStatusDot(color: Color.amux.cinnabar, breathes: false)
                    IntroTextLine(width: 34, strong: true)
                }
                IntroTextLine(width: 50)
                IntroTextLine(width: 38)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .introPaper()

            IntroTextLine(width: 44)
            IntroTextLine(width: 30)
            Spacer(minLength: 0)
        }
        .padding(8)
        .frame(width: 84, height: 150)
        .background(Color.amux.mist)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color.amux.onyx.opacity(0.35), lineWidth: 1)
        )
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

private struct IntroSheet: View {
    let showsTitle: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if showsTitle {
                IntroTextLine(width: 58, strong: true).padding(.bottom, 4)
                IntroTextLine(width: 80)
                IntroTextLine(width: 66)
                IntroTextLine(width: 76)
                IntroTextLine(width: 44)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .frame(width: 112, height: 136, alignment: .topLeading)
        .introPaper()
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
