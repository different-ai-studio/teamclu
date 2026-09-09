import XCTest
@testable import AMUXCore

/// The invite link has to name the backend it belongs to: onboarding reads the
/// address straight off it, so an invitee is never asked to type one.
final class InviteDeeplinkTests: XCTestCase {

    private let expiry = Date(timeIntervalSince1970: 1_800_000_000)

    private func deeplink(_ raw: String, cloudAPIURL: URL? = nil) -> String {
        InviteCreated(token: "tok", expiresAt: expiry, deeplink: raw, cloudAPIURL: cloudAPIURL).deeplink
    }

    func testRewritesTheBackendSchemeToOneTheOSRegisters() {
        XCTAssertEqual(deeplink("amux://invite?token=tok"), "teamclu://invite?token=tok")
    }

    func testCarriesTheEndpointTheInviteWasMintedAgainst() {
        XCTAssertEqual(
            deeplink("amux://invite?token=tok", cloudAPIURL: URL(string: "https://api.acme.test")!),
            "teamclu://invite?token=tok&cloud_api_url=https%3A%2F%2Fapi%2Eacme%2Etest"
        )
    }

    /// A trailing slash would survive percent-encoding and reach the invitee as
    /// part of the address; the client string-concatenates paths onto it.
    func testTrimsATrailingSlashOffTheEndpoint() {
        XCTAssertEqual(
            deeplink("amux://invite?token=tok", cloudAPIURL: URL(string: "https://api.acme.test/")!),
            "teamclu://invite?token=tok&cloud_api_url=https%3A%2F%2Fapi%2Eacme%2Etest"
        )
    }

    func testOmitsTheEndpointWhenNoneIsResolved() {
        XCTAssertEqual(deeplink("amux://invite?token=tok"), "teamclu://invite?token=tok")
    }

    /// An empty deeplink means the backend returned none; appending a bare
    /// query to it would produce a link that goes nowhere.
    func testLeavesAnEmptyDeeplinkEmpty() {
        XCTAssertEqual(deeplink("", cloudAPIURL: URL(string: "https://api.acme.test")!), "")
    }

    func testDoesNotAppendTwiceToALinkThatAlreadyNamesAnEndpoint() {
        let already = "teamclu://invite?token=tok&cloud_api_url=https%3A%2F%2Fapi.old.test"
        XCTAssertEqual(deeplink(already, cloudAPIURL: URL(string: "https://api.acme.test")!), already)
    }
}
