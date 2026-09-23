import SwiftUI
import UIKit
import AMUXCore
import AMUXSharedUI

/// "Start a new team" → get the desktop app. A phone can't install it, so the
/// job here is getting the link onto a computer: share it (AirDrop, a chat to
/// yourself) or copy it. The URL comes from the server, with a built-in
/// fallback.
struct DesktopGuideView: View {
    enum Mode {
        /// From the choice screen: continuing goes to sign-in.
        case beforeSignIn
        /// From the no-team screen, already signed in: continuing creates the team.
        case signedIn
    }

    let mode: Mode
    let onContinue: () -> Void

    @State private var downloadURL = BrandInfo.defaultDesktopDownloadURL
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Get the desktop app")
                    .font(.amuxSerif(34, weight: .regular))
                    .foregroundStyle(Color.amux.onyx)
                Text("Your team's agents run on a computer. Install \(BrandInfo.appName) for Mac or Windows there — that's where you create the team and invite people.")
                    .font(.body)
                    .foregroundStyle(Color.amux.basalt)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 40)
            .padding(.horizontal, 28)

            linkBlock
                .padding(.top, 32)
                .padding(.horizontal, 24)

            Spacer(minLength: 24)

            VStack(spacing: 12) {
                ShareLink(item: downloadURL) {
                    Label("Share download link", systemImage: "square.and.arrow.up")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .glassProminentButtonStyle()
                .simultaneousGesture(TapGesture().onEnded {
                    Analytics.track("onboarding_desktop_link_shared", ["via": "share"])
                })
                .accessibilityIdentifier("desktopGuide.shareButton")

                Button(action: onContinue) {
                    Text(continueTitle)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.amux.basalt)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("desktopGuide.continueButton")
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 40)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.amux.mist)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard let base = CloudAPIConfigurationStore.configuration()?.baseURL,
                  let url = await BrandInfo.fetchDesktopDownloadURL(baseURL: base)
            else { return }
            downloadURL = url
        }
    }

    private var continueTitle: LocalizedStringKey {
        switch mode {
        case .beforeSignIn: "Sign in on this phone first"
        case .signedIn: "Create my team now"
        }
    }

    private var linkBlock: some View {
        HStack(spacing: 12) {
            Text(displayURL)
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(Color.amux.onyx)
                .lineLimit(2)
                .truncationMode(.middle)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            Button {
                UIPasteboard.general.url = downloadURL
                Analytics.track("onboarding_desktop_link_shared", ["via": "copy"])
                copied = true
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    copied = false
                }
            } label: {
                Text(copied ? "Copied" : "Copy")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(copied ? Color.amux.sage : Color.amux.cinnabar)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("desktopGuide.copyButton")
        }
        .padding(16)
        .background(Color.amux.paper)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .stroke(Color.amux.hairline, lineWidth: 0.5)
        )
    }

    /// Scheme stripped: people read it off the phone and type it on a computer.
    private var displayURL: String {
        let s = downloadURL.absoluteString
        for prefix in ["https://", "http://"] where s.hasPrefix(prefix) {
            return String(s.dropFirst(prefix.count))
        }
        return s
    }
}
