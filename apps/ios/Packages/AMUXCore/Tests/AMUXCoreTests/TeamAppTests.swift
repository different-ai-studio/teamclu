import Testing
import Foundation
@testable import AMUXCore

@Suite("TeamApp status")
struct TeamAppStatusTests {

    private func app(
        provision: TeamAppProvisionStatus,
        fc: TeamAppFcStatus? = nil,
        publicURL: String? = nil
    ) -> TeamAppRecord {
        TeamAppRecord(
            id: "a1", teamID: "t1", name: "Demo", slug: "demo",
            type: .staticWeb, visibility: .personal,
            provisionStatus: provision, fcStatus: fc,
            publicURL: publicURL.flatMap(URL.init(string:)),
            createdAt: .distantPast, updatedAt: .distantPast
        )
    }

    @Test("a live app with an address reads as online")
    func liveWithURL() {
        let row = app(provision: .ready, fc: .live, publicURL: "https://demo.example.com")
        #expect(row.statusLabel == "已上线")
        #expect(row.statusKind == .live)
    }

    @Test("live without an address falls through to the provisioning state")
    func liveWithoutURL() {
        // The server reports `live` before the endpoint is readable in some
        // orderings; claiming "已上线" with nothing to open would be a link
        // the user cannot follow.
        let row = app(provision: .ready, fc: .live)
        #expect(row.statusLabel == "待部署")
        #expect(row.statusKind == .idle)
    }

    @Test("deploy state outranks a ready provision state")
    func deployOutranksProvision() {
        #expect(app(provision: .ready, fc: .deployError).statusLabel == "部署失败")
        #expect(app(provision: .ready, fc: .building).statusLabel == "部署中…")
        #expect(app(provision: .ready, fc: .awaitingBuild).statusKind == .working)
    }

    @Test("an app that has never been deployed shows its provisioning state")
    func neverDeployed() {
        #expect(app(provision: .ready).statusLabel == "待部署")
        #expect(app(provision: .error).statusLabel == "初始化失败")
        #expect(app(provision: .repoCreated).statusLabel == "待初始化")
        #expect(app(provision: .pending).statusLabel == "待初始化")
        #expect(app(provision: .seeding).statusLabel == "待初始化")
    }

    @Test("only a seeded app escapes the desktop hint")
    func needsDesktopSetup() {
        // This is what every app created from iOS looks like, and the hint is
        // the only thing standing between the user and a deploy button that
        // would answer 409 app_not_ready.
        #expect(app(provision: .repoCreated).needsDesktopSetup)
        #expect(app(provision: .pending).needsDesktopSetup)
        #expect(app(provision: .seeding).needsDesktopSetup)
        #expect(!app(provision: .ready).needsDesktopSetup)
        // A failed seed is not "still coming" — it has its own label, and
        // telling the user to go finish it on a desktop would be wrong.
        #expect(!app(provision: .error).needsDesktopSetup)
    }

    @Test("source label reads from how the repo is authenticated")
    func sourceLabel() {
        var row = app(provision: .ready)
        row.gitAuthKind = "gitea_deploy_key"
        row.gitRemoteURL = "ssh://git@gitea/app.git"
        #expect(row.sourceLabel == "托管仓库")

        var external = app(provision: .ready)
        external.gitRemoteURL = "https://github.com/acme/site.git"
        #expect(external.sourceLabel == "外部仓库")

        #expect(app(provision: .ready).sourceLabel == "仅本机")
    }

    @Test("the openable address prefers the derived public URL")
    func openableURL() {
        var row = app(provision: .ready, fc: .live, publicURL: "https://demo.example.com")
        row.fcEndpoint = URL(string: "https://raw-fc-endpoint.example.com")
        #expect(row.openableURL?.absoluteString == "https://demo.example.com")

        var endpointOnly = app(provision: .ready, fc: .live)
        endpointOnly.fcEndpoint = URL(string: "https://raw-fc-endpoint.example.com")
        #expect(endpointOnly.openableURL?.absoluteString == "https://raw-fc-endpoint.example.com")
    }

    @Test("imported and the legacy type are not offered when creating")
    func creatableTypes() {
        #expect(TeamAppType.creatable == [.staticWeb, .slides, .dataApp])
        #expect(!TeamAppType.creatable.contains(.imported))
        #expect(!TeamAppType.creatable.contains(.fullstackTanstackPostgres))
    }
}

@Suite("CloudAPITeamAppRepository")
struct CloudAPITeamAppRepositoryTests {

    private func makeClient(
        body: String,
        status: Int = 200,
        onRequest: (@Sendable (URLRequest) -> Void)? = nil
    ) -> CloudAPIClient {
        CloudAPIClient(
            configuration: CloudAPIConfiguration(baseURL: URL(string: "https://api.example.com")!),
            accessToken: { "test-token" },
            send: { request in
                onRequest?(request)
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
                )!
                return (Data(body.utf8), response)
            }
        )
    }

    @Test("decodes a list and maps every field it renders")
    func decodesList() async throws {
        let repo = CloudAPITeamAppRepository(client: makeClient(body: """
        {"items":[{
          "id":"app-1","teamId":"t1","createdByActorId":"actor-9",
          "name":"周会看板","slug":"zhou-hui","type":"slides","visibility":"team",
          "provisionStatus":"ready","fcStatus":"live",
          "publicUrl":"https://zhou-hui-abc12345.apps.example.com",
          "fcEndpoint":"https://fc.example.com/x",
          "gitRemoteUrl":"ssh://git@gitea/app.git","gitAuthKind":"gitea_deploy_key",
          "relationship":"owner",
          "createdAt":"2026-09-01T10:00:00Z","updatedAt":"2026-09-02T11:30:00Z"
        }]}
        """))
        let apps = try await repo.listApps(teamID: "t1")
        #expect(apps.count == 1)
        let app = try #require(apps.first)
        #expect(app.id == "app-1")
        #expect(app.name == "周会看板")
        #expect(app.type == .slides)
        #expect(app.visibility == .team)
        #expect(app.provisionStatus == .ready)
        #expect(app.fcStatus == .live)
        #expect(app.relationship == .owner)
        #expect(app.statusLabel == "已上线")
        #expect(app.openableURL?.absoluteString == "https://zhou-hui-abc12345.apps.example.com")
    }

    @Test("a missing fcStatus stays nil rather than becoming a deploy state")
    func missingFcStatusStaysNil() async throws {
        let repo = CloudAPITeamAppRepository(client: makeClient(body: """
        {"items":[{"id":"a","teamId":"t","name":"n","slug":"n","type":"static_web",
          "visibility":"personal","provisionStatus":"repo_created",
          "createdAt":"2026-09-01T10:00:00Z","updatedAt":"2026-09-01T10:00:00Z"}]}
        """))
        let app = try #require(try await repo.listApps(teamID: "t").first)
        #expect(app.fcStatus == nil)
        #expect(app.statusLabel == "待初始化")
        #expect(app.needsDesktopSetup)
    }

    @Test("unknown enum values fall back without failing the whole decode")
    func unknownEnumsFallBack() async throws {
        // A server that adds a type or a status must not blank the list on an
        // older build. The fallbacks are chosen to be conservative: an unknown
        // type reads as `imported` (claims nothing about the contents) and an
        // unknown provisioning state reads as not-yet-ready.
        let repo = CloudAPITeamAppRepository(client: makeClient(body: """
        {"items":[{"id":"a","teamId":"t","name":"n","slug":"n","type":"quantum_app",
          "visibility":"galaxy","provisionStatus":"levitating","fcStatus":"vibing",
          "relationship":"acquaintance",
          "createdAt":"2026-09-01T10:00:00Z","updatedAt":"2026-09-01T10:00:00Z"}]}
        """))
        let app = try #require(try await repo.listApps(teamID: "t").first)
        #expect(app.type == .imported)
        #expect(app.visibility == .personal)
        #expect(app.provisionStatus == .pending)
        #expect(app.fcStatus == nil)
        #expect(app.relationship == .team)
        #expect(app.needsDesktopSetup)
    }

    @Test("create sends exactly the three required fields plus visibility")
    func createSendsBody() async throws {
        let captured = CapturedBody()
        let repo = CloudAPITeamAppRepository(client: makeClient(
            body: """
            {"id":"new","teamId":"t1","name":"看板","slug":"kan-ban","type":"static_web",
             "visibility":"personal","provisionStatus":"repo_created",
             "createdAt":"2026-09-01T10:00:00Z","updatedAt":"2026-09-01T10:00:00Z"}
            """,
            onRequest: { request in captured.store(request.httpBody) }
        ))
        let created = try await repo.createApp(
            teamID: "t1",
            input: TeamAppCreateInput(name: "  看板  ", type: .staticWeb, visibility: .personal)
        )
        #expect(created.id == "new")
        // Created rows arrive un-seeded; the UI leans on this to show the
        // "finish on a desktop" hint instead of a deploy affordance.
        #expect(created.needsDesktopSetup)

        let json = try #require(captured.json())
        #expect(json["teamId"] as? String == "t1")
        // Trimmed: a trailing space would otherwise reach the slug.
        #expect(json["name"] as? String == "看板")
        #expect(json["type"] as? String == "static_web")
        #expect(json["visibility"] as? String == "personal")
    }

    @Test("an all-whitespace name never reaches the network")
    func rejectsBlankName() async {
        let repo = CloudAPITeamAppRepository(client: makeClient(body: "{}", status: 500))
        await #expect(throws: TeamAppRepositoryError.self) {
            try await repo.createApp(teamID: "t1", input: TeamAppCreateInput(name: "   "))
        }
    }

    @Test("404 becomes notFound, because the server hides invisible apps that way")
    func notFoundIsTranslated() async {
        let repo = CloudAPITeamAppRepository(client: makeClient(
            body: #"{"error":{"code":"not_found","message":"nope"}}"#, status: 404
        ))
        await #expect(throws: TeamAppRepositoryError.self) {
            try await repo.getApp(appID: "gone")
        }
    }

    @Test("decodes linked sessions, including one that never got a message")
    func decodesSessions() async throws {
        let repo = CloudAPITeamAppRepository(client: makeClient(body: """
        {"items":[
          {"id":"s1","teamId":"t","title":"改配色","mode":"agent",
           "lastMessageAt":"2026-09-03T08:00:00Z",
           "createdAt":"2026-09-01T10:00:00Z","updatedAt":"2026-09-03T08:00:00Z"},
          {"id":"s2","teamId":"t","title":"","mode":"agent","lastMessageAt":null,
           "createdAt":"2026-09-01T10:00:00Z","updatedAt":"2026-09-01T10:00:00Z"}
        ]}
        """))
        let rows = try await repo.listAppSessions(appID: "app-1")
        #expect(rows.count == 2)
        #expect(rows[0].lastMessageAt != nil)
        #expect(rows[1].lastMessageAt == nil)
        #expect(rows[1].title.isEmpty)
    }
}

@Suite("BootstrapFeatureFlags")
struct BootstrapFeatureFlagsTests {

    private func makeClient(body: String) -> CloudAPIClient {
        CloudAPIClient(
            configuration: CloudAPIConfiguration(baseURL: URL(string: "https://api.example.com")!),
            accessToken: { "test-token" },
            send: { request in
                let response = HTTPURLResponse(
                    url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil
                )!
                return (Data(body.utf8), response)
            }
        )
    }

    @Test("reads apps from the bootstrap features block")
    func readsAppsFlag() async throws {
        let on = try await ServerBrokerConfig.fetchBootstrap(
            client: makeClient(body: #"{"features":{"apps":true}}"#)
        )
        #expect(on.features?.apps == true)

        let off = try await ServerBrokerConfig.fetchBootstrap(
            client: makeClient(body: #"{"features":{"apps":false}}"#)
        )
        #expect(off.features?.apps == false)
    }

    @Test("a present block with no apps key means off")
    func presentBlockMissingKeyIsOff() async throws {
        // FC only emits keys the deployment's profile sets, so a block that
        // omits `apps` is that deployment saying no — unlike a wholly absent
        // block, which is it saying nothing.
        let result = try await ServerBrokerConfig.fetchBootstrap(
            client: makeClient(body: #"{"features":{"lockLlmConfig":true}}"#)
        )
        #expect(result.features?.apps == false)
    }

    @Test("no features block at all leaves the client's defaults alone")
    func absentBlockIsNil() async throws {
        let result = try await ServerBrokerConfig.fetchBootstrap(
            client: makeClient(body: #"{"mqtt":{"tcpUrl":"mqtts://b.example.com:8883"}}"#)
        )
        #expect(result.features == nil)
        // And the broker still parses out of the same answer.
        #expect(result.broker == MQTTEndpoint(host: "b.example.com", port: 8883, useTLS: true))
    }

    @Test("the store keeps its current flags when handed nothing")
    @MainActor
    func storeIgnoresNil() {
        let store = FeatureFlagsStore()
        #expect(store.flags.apps)          // fail-open default
        store.apply(BootstrapFeatureFlags(apps: false))
        #expect(!store.flags.apps)
        store.apply(nil)                   // an unreachable server
        #expect(!store.flags.apps)         // …must not silently re-enable
    }
}

/// Captures a request body across the `@Sendable` send closure.
private final class CapturedBody: @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?

    func store(_ value: Data?) {
        lock.lock(); defer { lock.unlock() }
        data = value
    }

    func json() -> [String: Any]? {
        lock.lock(); defer { lock.unlock() }
        guard let data else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
