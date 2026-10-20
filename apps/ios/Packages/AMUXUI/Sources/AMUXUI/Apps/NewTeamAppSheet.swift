import SwiftUI
import AMUXCore
import AMUXSharedUI

/// Create an app: a name, a kind, and who can see it.
///
/// The desktop's form has a fourth choice — where the code comes from — with
/// three branches, two of which need a local folder or a git clone. Neither
/// can happen without a daemon, so this client only offers the one that
/// doesn't: "we make you a repo". The app that comes back still needs a
/// desktop to write the template into it, which the confirmation says plainly
/// rather than leaving the user to discover it from a stuck status.
struct NewTeamAppSheet: View {
    @Bindable var store: TeamAppsStore
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var type: TeamAppType = .staticWeb
    @State private var visibility: TeamAppVisibility = .personal
    @State private var submitting = false
    @State private var errorMessage: String?
    @FocusState private var nameFocused: Bool

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    nameCard
                    typeCard
                    visibilityCard
                    footnote
                    if let errorMessage {
                        Text(errorMessage)
                            .font(.system(size: 12.5))
                            .foregroundStyle(Color.amux.cinnabarDeep)
                            .padding(.horizontal, 24)
                    }
                }
                .padding(.vertical, 16)
            }
            .background(Color.amux.mist)
            .navigationTitle("新建应用")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("取消") { dismiss() }
                        .buttonStyle(.plain)
                        .foregroundStyle(Color.amux.basalt)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("创建") { Task { await submit() } }
                        .buttonStyle(.plain)
                        .foregroundStyle(
                            canSubmit ? Color.amux.cinnabar : Color.amux.slate.opacity(0.5)
                        )
                        .disabled(!canSubmit)
                        .accessibilityIdentifier("apps.submitNewAppButton")
                }
            }
            .onAppear { nameFocused = true }
        }
    }

    private var canSubmit: Bool { !trimmedName.isEmpty && !submitting }

    // MARK: - Fields

    private var nameCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HaiSectionLabel("名字")
            HaiPaperCard {
                TextField("例如：周会看板", text: $name)
                    .font(.system(size: 15))
                    .foregroundStyle(Color.amux.onyx)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($nameFocused)
                    .submitLabel(.done)
                    .onSubmit { if canSubmit { Task { await submit() } } }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 13)
                    .accessibilityIdentifier("apps.newAppNameField")
            }
        }
    }

    private var typeCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HaiSectionLabel("类型")
            HaiPaperCard {
                ForEach(Array(TeamAppType.creatable.enumerated()), id: \.element) { index, option in
                    Button { type = option } label: {
                        HStack(spacing: 10) {
                            Image(systemName: option.symbolName)
                                .font(.system(size: 15))
                                .foregroundStyle(Color.amux.basalt)
                                .frame(width: 22)
                            Text(option.label)
                                .font(.system(size: 14.5))
                                .foregroundStyle(Color.amux.onyx)
                            Spacer(minLength: 8)
                            if type == option {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Color.amux.cinnabar)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 13)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if index < TeamAppType.creatable.count - 1 { divider }
                }
            }
        }
    }

    private var visibilityCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HaiSectionLabel("谁能看到")
            HaiPaperCard {
                ForEach(Array(TeamAppVisibility.allCases.enumerated()), id: \.element) { index, option in
                    Button { visibility = option } label: {
                        HStack(spacing: 8) {
                            Text(option.label)
                                .font(.system(size: 14.5))
                                .foregroundStyle(Color.amux.onyx)
                            Spacer(minLength: 8)
                            if visibility == option {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundStyle(Color.amux.cinnabar)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 13)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if index < TeamAppVisibility.allCases.count - 1 { divider }
                }
            }
        }
    }

    private var footnote: some View {
        Text("创建后会先得到一条记录。代码要在电脑上打开 TeamClu 才能写入并部署——手机上建好，回到电脑继续。")
            .font(.system(size: 12.5))
            .foregroundStyle(Color.amux.slate)
            .lineSpacing(3)
            .padding(.horizontal, 24)
    }

    private var divider: some View {
        Rectangle()
            .fill(Color.amux.hairline)
            .frame(height: 0.5)
            .padding(.leading, 14)
    }

    // MARK: - Submit

    private func submit() async {
        guard canSubmit else { return }
        submitting = true
        defer { submitting = false }
        errorMessage = nil
        do {
            try await store.create(
                TeamAppCreateInput(name: trimmedName, type: type, visibility: visibility)
            )
            dismiss()
        } catch {
            // Stay open: the name is still typed, and the common failures
            // (a duplicate slug, Gitea unreachable) are worth re-reading
            // before deciding what to do.
            errorMessage = error.localizedDescription
        }
    }
}
