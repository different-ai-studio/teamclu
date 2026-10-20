import Foundation
import Testing
@testable import AMUXCore

@Suite("BrandInfo")
struct BrandInfoTests {

    private func parse(_ json: String) -> URL? {
        BrandInfo.desktopDownloadURL(fromPublicConfig: Data(json.utf8))
    }

    @Test("reads the download URL the server sends")
    func readsServerURL() {
        #expect(parse(#"{"desktopDownloadUrl":"https://example.com/download","features":{}}"#)
                == URL(string: "https://example.com/download"))
    }

    @Test("a server without the field yields nil so the default is kept")
    func missingFieldIsNil() {
        #expect(parse(#"{"features":{"auth":{"google":true}}}"#) == nil)
    }

    @Test("non-web or malformed URLs are ignored")
    func rejectsNonWebURLs() {
        #expect(parse(#"{"desktopDownloadUrl":"javascript:alert(1)"}"#) == nil)
        #expect(parse(#"{"desktopDownloadUrl":"not a url"}"#) == nil)
        #expect(parse(#"{"desktopDownloadUrl":""}"#) == nil)
    }
}
