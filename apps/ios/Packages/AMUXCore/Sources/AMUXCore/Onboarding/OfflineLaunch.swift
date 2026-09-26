import Foundation
import Network

/// Recognises "the device can't reach the server" apart from the server
/// answering with an error. Only the former lets bootstrap fall back to the
/// last team this device was in; a server-side refusal must still surface.
public enum NetworkErrorClassifier {
    public static func isUnreachable(_ error: Error) -> Bool {
        guard let urlError = error as? URLError else { return false }
        switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost,
             .cannotConnectToHost, .dnsLookupFailed, .timedOut,
             .internationalRoamingOff, .dataNotAllowed, .callIsActive:
            return true
        default:
            return false
        }
    }
}

/// Emits `true` each time the device regains a usable network path.
public enum NetworkPathUpdates {
    public static func becameReachable() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let monitor = NWPathMonitor()
            monitor.pathUpdateHandler = { path in
                if path.status == .satisfied { continuation.yield() }
            }
            continuation.onTermination = { _ in monitor.cancel() }
            monitor.start(queue: DispatchQueue(label: "teamclu.network-path"))
        }
    }
}
