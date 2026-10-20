import SwiftUI
import AMUXSharedUI
import AMUXCore

@MainActor
public struct NotificationsSettingsView: View {
    let store: NotificationPrefsStore

    public init(store: NotificationPrefsStore) {
        self.store = store
    }

    public var body: some View {
        ZStack {
            Color.amux.mist.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HaiPaperCard {
                        toggleRow("Enable push notifications", isOn: Binding(
                            get: { store.prefs.enabled },
                            set: { on in Task { await store.setEnabled(on) } }
                        ))
                        .accessibilityIdentifier("notifications.pushToggle")
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        HaiSectionLabel(String(localized: "Do Not Disturb"))
                        HaiPaperCard {
                            toggleRow("Enabled", isOn: Binding(
                                get: { store.prefs.dndStartMin != nil },
                                set: { on in
                                    Task {
                                        if on {
                                            await store.setQuietHours(
                                                startMin: store.prefs.dndStartMin ?? 22 * 60,
                                                endMin: store.prefs.dndEndMin ?? 7 * 60
                                            )
                                        } else {
                                            await store.setQuietHours(startMin: nil, endMin: nil)
                                        }
                                    }
                                }
                            ))
                            .accessibilityIdentifier("notifications.dndToggle")

                            if store.prefs.dndStartMin != nil {
                                hairline
                                timeRow("Start", selection: bindMinute(
                                    get: { store.prefs.dndStartMin },
                                    set: { newStart in
                                        Task {
                                            await store.setQuietHours(
                                                startMin: newStart,
                                                endMin: store.prefs.dndEndMin
                                            )
                                        }
                                    }
                                ))
                                hairline
                                timeRow("End", selection: bindMinute(
                                    get: { store.prefs.dndEndMin },
                                    set: { newEnd in
                                        Task {
                                            await store.setQuietHours(
                                                startMin: store.prefs.dndStartMin,
                                                endMin: newEnd
                                            )
                                        }
                                    }
                                ))
                            }
                        }
                    }

                    if let error = store.errorMessage {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(Color.amux.cinnabarDeep)
                            .padding(.horizontal, 24)
                    }
                }
                .padding(.top, 12)
                .padding(.bottom, 24)
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await store.reload()
        }
    }

    private var hairline: some View {
        Rectangle().fill(Color.amux.hairline).frame(height: 0.5)
            .padding(.leading, 14)
    }

    private func toggleRow(_ title: LocalizedStringKey, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            Text(title)
                .font(.system(size: 14.5))
                .foregroundStyle(Color.amux.onyx)
        }
        .tint(Color.amux.cinnabar)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
    }

    private func timeRow(_ title: LocalizedStringKey, selection: Binding<Date>) -> some View {
        DatePicker(selection: selection, displayedComponents: .hourAndMinute) {
            Text(title)
                .font(.system(size: 14.5))
                .foregroundStyle(Color.amux.onyx)
        }
        .tint(Color.amux.cinnabar)
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
    }

    /// Bridge a minute-of-day Int? to the hour+minute DatePicker.
    private func bindMinute(
        get: @escaping () -> Int?,
        set: @escaping (Int) -> Void
    ) -> Binding<Date> {
        Binding(
            get: {
                let m = get() ?? 0
                return Calendar.current.date(
                    bySettingHour: m / 60, minute: m % 60, second: 0, of: Date()
                ) ?? Date()
            },
            set: { newDate in
                let comps = Calendar.current.dateComponents([.hour, .minute], from: newDate)
                set((comps.hour ?? 0) * 60 + (comps.minute ?? 0))
            }
        )
    }
}
