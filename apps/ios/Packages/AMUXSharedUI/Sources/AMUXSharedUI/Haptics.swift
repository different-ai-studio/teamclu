#if canImport(UIKit)
import UIKit
#endif

/// The few haptics the chat uses, named by what they confirm. Called from
/// button actions, where a one-line imperative call reads better than a
/// `sensoryFeedback` trigger state per control.
///
/// No-ops where UIKit is absent: the package also builds for macOS, which is
/// how CI runs its tests.
@MainActor
public enum Haptics {
    /// A message went out; a recording started or stopped.
    public static func tap() {
        #if canImport(UIKit)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }

    /// Moved somewhere in the transcript (jump to bottom / to unread).
    public static func selection() {
        #if canImport(UIKit)
        UISelectionFeedbackGenerator().selectionChanged()
        #endif
    }

    /// Something was approved or copied.
    public static func success() {
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
    }

    /// Something was refused.
    public static func warning() {
        #if canImport(UIKit)
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        #endif
    }
}
