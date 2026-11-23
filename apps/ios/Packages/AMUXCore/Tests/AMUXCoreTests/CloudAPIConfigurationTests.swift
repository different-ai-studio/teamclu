import Foundation
import Testing
@testable import AMUXCore

@Suite("Cloud API configuration")
struct CloudAPIConfigurationTests {
    @Test
    func defaultsToBundledCloudURL() {
        // No stored override. The bundled services.default.json ships a
        // cloudApiUrl, so a usable configuration is resolved from it.
        let defaults = UserDefaults(suiteName: "CloudAPIConfigurationTests.defaults")!
        defaults.removePersistentDomain(forName: "CloudAPIConfigurationTests.defaults")

        let config = CloudAPIConfigurationStore.configuration(in: defaults)
        #expect(config != nil)
        #expect(config?.baseURL.absoluteString == "https://api.teamclu-dev.ucar.cc")
    }

    @Test
    func buildsCloudAPIConfigurationWhenStored() throws {
        let suite = "CloudAPIConfigurationTests.cloud"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        defaults.set("https://fc.example.com", forKey: CloudAPIConfigurationStore.cloudAPIURLKey)

        let config = try #require(CloudAPIConfigurationStore.configuration(in: defaults))
        #expect(config.baseURL.absoluteString == "https://fc.example.com")
    }
}
