import Foundation
import Testing
@testable import AMUXUI

/// Reading a bucket and an object path back out of a stored picture URL.
///
/// This decides whether a tile asks the API to resize the picture or fetches
/// the whole thing, so getting it wrong is silent: every tile still draws, it
/// just downloads megabytes to do it.
@Suite("Idea image locations")
struct IdeaImageLocationTests {
    @Test("splits a public storage URL into bucket and path")
    func splitsPublicURL() throws {
        let url = try #require(URL(string:
            "https://supabase.example.com/storage/v1/object/public/attachments/team-1/ideas/photo.jpg"))
        let location = try #require(IdeaThumbnailLoader.storageLocation(of: url))
        #expect(location.bucket == "attachments")
        #expect(location.path == "team-1/ideas/photo.jpg")
    }

    @Test("unescapes the path once, because that is what the API is given")
    func decodesEscapes() throws {
        let url = try #require(URL(string:
            "https://supabase.example.com/storage/v1/object/public/attachments/team%201/a%20photo.jpg"))
        let location = try #require(IdeaThumbnailLoader.storageLocation(of: url))
        #expect(location.path == "team 1/a photo.jpg")
    }

    @Test("and only once — a name that really contains a % survives")
    func doesNotDecodeTwice() throws {
        // The object is named `a%20b.jpg`; the URL escapes the `%` itself.
        let url = try #require(URL(string:
            "https://supabase.example.com/storage/v1/object/public/attachments/a%2520b.jpg"))
        let location = try #require(IdeaThumbnailLoader.storageLocation(of: url))
        #expect(location.path == "a%20b.jpg")
    }

    @Test("a picture from somewhere else is left alone", arguments: [
        // Not storage at all.
        "https://example.com/photo.jpg",
        // Storage, but a signed or authenticated object rather than a public one.
        "https://supabase.example.com/storage/v1/object/sign/attachments/team-1/photo.jpg",
        // A bucket with nothing in it.
        "https://supabase.example.com/storage/v1/object/public/attachments/",
        // No bucket.
        "https://supabase.example.com/storage/v1/object/public/",
    ])
    func leavesOthersAlone(raw: String) throws {
        let url = try #require(URL(string: raw))
        #expect(IdeaThumbnailLoader.storageLocation(of: url) == nil)
    }
}
