import SwiftUI
import AMUXSharedUI
import SwiftData
import AMUXCore

#if os(iOS)

public struct MemberInviteSheet: View {
    @Environment(\.dismiss) private var dismiss
    let store: ActorStore
    let canManage: Bool

    @State private var kind: InviteKind = .member
    @State private var name = ""
    @State private var teamRole: TeamRole = .member
    @State private var agentKind: String = "daemon"
    @State private var isInviting = false
    @State private var errorMessage: String?
    @State private var invite: InviteCreated?
    // Shown when a member invite is blocked because the team is still in the
    // shared default org (FC 403 upgrade_required) — prompts an org upgrade.
    @State private var needsUpgrade = false
    @State private var orgName = ""
    @State private var contact = ""
    @State private var isUpgrading = false
    @State private var joinLink: TeamJoinLink?
    @State private var joinTtl: TeamJoinLinkTtl = .sevenDays
    @State private var joinCap = ""
    @State private var isJoinBusy = false

    public init(store: ActorStore, canManage: Bool = false) {
        self.store = store
        self.canManage = canManage
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    private var canInvite: Bool {
        !trimmedName.isEmpty && !isInviting && invite == nil
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Kind", selection: $kind) {
                        Text("Teammate").tag(InviteKind.member)
                        Text("Agent").tag(InviteKind.agent)
                    }
                    .pickerStyle(.segmented)
                    .disabled(invite != nil)
                    .accessibilityIdentifier("invite.kindPicker")

                    TextField("Name", text: $name)
                        .disabled(invite != nil)
                        .accessibilityIdentifier("invite.nameField")

                    if kind == .member {
                        Picker("Role", selection: $teamRole) {
                            Text("Member").tag(TeamRole.member)
                            Text("Admin").tag(TeamRole.admin)
                        }.disabled(invite != nil)
                    } else {
                        Picker("Agent kind", selection: $agentKind) {
                            Text("Daemon").tag("daemon")
                        }.disabled(invite != nil)
                    }
                } footer: {
                    if let errorMessage, !needsUpgrade {
                        Text(errorMessage).foregroundStyle(Color.amux.cinnabarDeep)
                    }
                }

                if needsUpgrade {
                    Section {
                        Text("This team still lives in the shared public org, so it's single-user. Upgrade your account and create your own team to invite members.")
                            .font(.footnote).foregroundStyle(.secondary)
                        TextField("Team / org name", text: $orgName)
                            .accessibilityIdentifier("invite.upgradeOrgName")
                        TextField("Contact (optional)", text: $contact)
                        Button {
                            upgrade()
                        } label: {
                            if isUpgrading { ProgressView() } else { Text("Upgrade account") }
                        }
                        .disabled(orgName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isUpgrading)
                        .accessibilityIdentifier("invite.upgradeButton")
                    } header: {
                        Text("Upgrade account")
                    } footer: {
                        if let errorMessage {
                            Text(errorMessage).foregroundStyle(Color.amux.cinnabarDeep)
                        }
                    }
                }

                if canManage {
                    joinLinkSection
                }

                if let invite {
                    Section("Share invite") {
                        Text(invite.deeplink).font(.footnote)
                            .textSelection(.enabled).foregroundStyle(.secondary)
                            .accessibilityIdentifier("invite.deeplinkText")
                        ShareLink(item: invite.deeplink) {
                            Label("Share link", systemImage: "square.and.arrow.up")
                        }
                        .accessibilityIdentifier("invite.shareLinkButton")
                        Button {
                            UIPasteboard.general.string = invite.deeplink
                        } label: {
                            Label("Copy link", systemImage: "doc.on.doc")
                        }
                        .accessibilityIdentifier("invite.copyLinkButton")
                        LabeledContent("Expires",
                                       value: invite.expiresAt.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Color.amux.mist)
            .navigationTitle("Invite")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { reset(); dismiss() } label: {
                        Image(systemName: "xmark").font(.title3).foregroundStyle(.secondary)
                    }.buttonStyle(.plain)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    if invite != nil {
                        Button { reset(); dismiss() } label: { Text("Done") }
                            .accessibilityIdentifier("invite.doneButton")
                    } else {
                        Button { run() } label: {
                            HStack(spacing: 6) {
                                if isInviting { ProgressView().controlSize(.small) }
                                Text("Invite")
                            }
                        }
                        .disabled(!canInvite)
                        .opacity(canInvite ? 1 : 0.4)
                        .accessibilityIdentifier("invite.submitButton")
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task {
            guard canManage else { return }
            await loadJoinLink()
        }
    }

    @ViewBuilder
    private var joinLinkSection: some View {
        Section {
            Picker("Link expires", selection: $joinTtl) {
                Text("7 days").tag(TeamJoinLinkTtl.sevenDays)
                Text("30 days").tag(TeamJoinLinkTtl.thirtyDays)
                Text("Never").tag(TeamJoinLinkTtl.never)
            }
            .disabled(isJoinBusy)
            .onChange(of: joinTtl) { _, next in
                guard let link = joinLink, let cap = parsedCap() else { return }
                guard Self.inferTtl(link) != next else { return }
                saveJoinLink(ttl: next, maxUses: cap, rotate: false)
            }

            TextField("Max uses (optional)", text: $joinCap)
                .keyboardType(.numberPad)
                .disabled(isJoinBusy)
                .onChange(of: joinCap) { _, _ in
                    guard let link = joinLink, let cap = parsedCap() else { return }
                    guard cap != link.maxUses else { return }
                    saveJoinLink(ttl: joinTtl, maxUses: cap, rotate: false)
                }

            if let joinLink {
                Text(joinLink.url)
                    .font(.footnote)
                    .textSelection(.enabled)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("invite.joinLinkURL")
                Button {
                    UIPasteboard.general.string = joinLink.url
                } label: {
                    Label("Copy link", systemImage: "doc.on.doc")
                }
                .disabled(isJoinBusy)
                .accessibilityIdentifier("invite.copyJoinLinkButton")
                LabeledContent("Uses", value: "\(joinLink.useCount)")
                    .font(.caption)
                LabeledContent("Status", value: joinLink.status)
                    .font(.caption)
                Button {
                    saveJoinLink(ttl: joinTtl, maxUses: parsedCap() ?? joinLink.maxUses, rotate: true)
                } label: {
                    Label("Rotate link", systemImage: "arrow.triangle.2.circlepath")
                }
                .disabled(isJoinBusy)
                Button(role: .destructive) {
                    revokeJoinLink()
                } label: {
                    if isJoinBusy { ProgressView() } else { Label("Revoke link", systemImage: "trash") }
                }
                .disabled(isJoinBusy)
            } else {
                Button {
                    saveJoinLink(ttl: joinTtl, maxUses: parsedCap() ?? nil, rotate: false)
                } label: {
                    if isJoinBusy { ProgressView() } else { Text("Generate join link") }
                }
                .disabled(isJoinBusy || parsedCap() == nil && !joinCap.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("invite.generateJoinLinkButton")
            }
        } header: {
            Text("Anyone with the link")
        } footer: {
            if let errorMessage, !needsUpgrade, joinLink == nil {
                Text(errorMessage).foregroundStyle(Color.amux.cinnabarDeep)
            }
        }
    }

    private func parsedCap() -> Int?? {
        let trimmed = joinCap.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .some(nil) }
        guard let value = Int(trimmed), value >= 1 else { return nil }
        return .some(value)
    }

    private func loadJoinLink() async {
        let row = await store.getJoinLink()
        joinLink = row
        if let row {
            joinTtl = Self.inferTtl(row)
            joinCap = row.maxUses.map(String.init) ?? ""
        } else if let msg = store.errorMessage {
            errorMessage = msg
        }
    }

    private static func inferTtl(_ row: TeamJoinLink) -> TeamJoinLinkTtl {
        guard let expires = row.expiresAt else { return .never }
        let duration = expires.timeIntervalSince(row.createdAt)
        let seven = 7 * 24 * 60 * 60.0
        let thirty = 30 * 24 * 60 * 60.0
        return abs(duration - thirty) < abs(duration - seven) ? .thirtyDays : .sevenDays
    }

    private func saveJoinLink(ttl: TeamJoinLinkTtl, maxUses: Int?, rotate: Bool) {
        isJoinBusy = true
        Task {
            if let row = await store.putJoinLink(ttl: ttl, maxUses: maxUses, rotate: rotate) {
                joinLink = row
                joinTtl = ttl
                if store.lastErrorCode == nil { errorMessage = nil }
            } else if store.lastErrorCode == "upgrade_required" {
                needsUpgrade = true
                errorMessage = nil
            } else {
                errorMessage = store.errorMessage ?? String(localized: "Couldn't update the join link.")
            }
            isJoinBusy = false
        }
    }

    private func revokeJoinLink() {
        isJoinBusy = true
        Task {
            if await store.revokeJoinLink() {
                joinLink = nil
                joinCap = ""
                errorMessage = nil
            } else {
                errorMessage = store.errorMessage ?? String(localized: "Couldn't revoke the join link.")
            }
            isJoinBusy = false
        }
    }

    private func run() {
        errorMessage = nil
        guard canInvite else { return }
        isInviting = true
        Task {
            let input = InviteCreateInput(
                kind: kind, displayName: trimmedName,
                teamRole: kind == .member ? teamRole : nil,
                agentKind: kind == .agent ? agentKind : nil
            )
            if let created = await store.createInvite(input) {
                invite = created
            } else if store.lastErrorCode == "upgrade_required" {
                needsUpgrade = true
                errorMessage = nil
            } else {
                errorMessage = store.errorMessage ?? "Failed to create invite."
            }
            isInviting = false
        }
    }

    private func upgrade() {
        let trimmedOrg = orgName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedOrg.isEmpty, !isUpgrading else { return }
        errorMessage = nil
        isUpgrading = true
        Task {
            let trimmedContact = contact.trimmingCharacters(in: .whitespacesAndNewlines)
            if await store.upgradeAccount(orgName: trimmedOrg, contact: trimmedContact.isEmpty ? nil : trimmedContact) != nil {
                // Team left the default org — clear the prompt so the user can
                // invite. (Session/team refresh is handled by the app's stores.)
                needsUpgrade = false
                orgName = ""; contact = ""
            } else {
                errorMessage = store.errorMessage ?? String(localized: "Upgrade failed — please try again.")
            }
            isUpgrading = false
        }
    }

    private func reset() {
        kind = .member; name = ""; teamRole = .member; agentKind = "daemon"
        isInviting = false; errorMessage = nil; invite = nil
        needsUpgrade = false; orgName = ""; contact = ""; isUpgrading = false
    }
}
#else
public struct MemberInviteSheet: View {
    public init(store: ActorStore, canManage: Bool = false) {}
    public var body: some View { Text("Invites are iOS-only.").padding(24) }
}
#endif
