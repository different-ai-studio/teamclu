import UIKit

/// The few haptics the chat uses, named by what they confirm. Called from
/// button actions, where a one-line imperative call reads better than a
/// `sensoryFeedback` trigger state per control.
@MainActor
public enum Haptics {
    /// A message went out; a recording started or stopped.
    public static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// Moved somewhere in the transcript (jump to bottom / to unread).
    public static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }

    /// Something was approved or copied.
    public static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    /// Something was refused.
    public static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}
