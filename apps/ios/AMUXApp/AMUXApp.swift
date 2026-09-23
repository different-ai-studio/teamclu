import SwiftUI
import SwiftData
import AMUXCore
import AMUXSharedUI
import Sentry

@main
struct AMUXApp: App {
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) var pushDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var pairing = PairingManager()
    let modelContainer: ModelContainer

    init() {
        SentrySDK.start { options in
            options.dsn = "https://7551f3236520b84b27ec473a1d7c1480@o60909.ingest.us.sentry.io/4511233545011200"
            options.tracesSampleRate = 0.2
            options.enableAutoPerformanceTracing = true
            options.enableUIViewControllerTracing = true
            options.enableSwizzling = true
            // Sentry's Core Data swizzling spams "saveSpan is nil" once per
            // SwiftData save (every event the chat view streams). Disable it —
            // we don't have any direct Core Data usage to observe anyway.
            options.enableCoreDataTracing = false
            options.attachScreenshot = true
            options.attachViewHierarchy = true
            #if DEBUG
            options.debug = true
            options.environment = "development"
            #else
            options.environment = "production"
            #endif
        }

        // Product analytics (Aptabase). Anonymous, privacy-first — shares the
        // same app key as desktop. See Analytics.swift. The AMUXCore seam lets
        // domain-layer code emit events without depending on the vendor SDK.
        Analytics.start()
        AnalyticsSink.handler = { event, props in Analytics.track(event, props) }
        Analytics.track("app_started")

        // Explicit VersionedSchema + migration plan so SwiftData never falls
        // back to destructive migration on a field-shape change. See
        // AMUXSchema.swift for the upgrade checklist when models evolve.
        do {
            modelContainer = try AMUXModelContainerFactory.make()
        } catch {
            fatalError("Failed to initialise ModelContainer: \(error)")
        }
        NotificationCenter.default.addObserver(
            forName: .amuxApnsTokenReady, object: nil, queue: .main) { note in
            guard let hex = note.userInfo?["token"] as? String else { return }
            Task { await PushBootstrap.shared.handleApnsToken(hex) }
        }

        // Wire Cloud-API-backed push adapters. The access-token closure reads
        // the current token straight from the Keychain-backed session each
        // call (no refresh here — the onboarding SessionStore owns refresh, so
        // we avoid double-refresh races). Identity is derived server-side from
        // the bearer; registration no-ops gracefully until a session exists.
        if let config = CloudAPIConfigurationStore.configuration() {
            let sessionStorage = KeychainSessionStorage()
            let pushClient = CloudAPIClient(configuration: config, accessToken: {
                guard let session = try sessionStorage.load(),
                      session.expiresAt.timeIntervalSinceNow > 0 else {
                    throw CloudAPIError.missingAccessToken
                }
                return session.accessToken
            })
            PushBootstrap.shared.registerWithCloudAPI(
                client: pushClient,
                isAuthenticated: { (try? sessionStorage.load()) != nil }
            )
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView(pairing: pairing)
                .onOpenURL { url in handle(url) }
                // App-wide tint flips iOS 26 glass buttons, tab-bar selection,
                // toggle accents, and other system tinted surfaces to the Hai
                // Cinnabar accent without disturbing liquid-glass behaviour.
                .tint(Color.amux.cinnabar)
        }
        .modelContainer(modelContainer)
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .active:
                Analytics.track("app_active")
                PushBootstrap.shared.heartbeat?.enterForeground()
            case .background: PushBootstrap.shared.heartbeat?.enterBackground()
            default: break
            }
        }
    }

    private func handle(_ url: URL) {
        guard let scheme = url.scheme, ["teamclu", "teamclaw", "amux"].contains(scheme) else { return }

        switch url.host {
        case "invite":
            guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let token = comps.queryItems?.first(where: { $0.name == "token" })?.value
            else { return }
            // Persist before posting: on a cold launch the notification has no
            // live listener (RootTabView isn't mounted until bootstrap finishes),
            // so the token would be lost and bootstrap would auto-create a junk
            // team. bootstrap() reads this key before its auto-create branch.
            UserDefaults.standard.set(token, forKey: InviteDeepLink.pendingTokenDefaultsKey)
            NotificationCenter.default.post(
                name: .amuxInviteTokenReceived, object: nil, userInfo: ["token": token]
            )
        case "auth-callback":
            NotificationCenter.default.post(
                name: .amuxAuthCallbackReceived, object: url
            )
        case "session":
            // teamclu://session/<id>
            let sid = url.pathComponents.last ?? ""
            if !sid.isEmpty {
                NotificationCenter.default.post(
                    name: .amuxOpenSession, object: nil, userInfo: ["session_id": sid])
            }
        default:
            break
        }
    }
}
