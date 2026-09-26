import Foundation

/// Row order for the new-session collaborator picker: the viewer's default
/// agent first, then everyone else by most recent contact, then the never-
/// contacted by name.
public enum ActorPickerOrdering {
    /// Most recent message each actor sent, from the local message cache.
    /// The cache only holds sessions the viewer is in, so this reads as "last
    /// time we talked".
    public static func lastContact(senders: [(actorID: String, at: Date)]) -> [String: Date] {
        senders.reduce(into: [:]) { result, message in
            if let current = result[message.actorID], current >= message.at { return }
            result[message.actorID] = message.at
        }
    }

    public static func order<T>(_ items: [T],
                                id: (T) -> String,
                                name: (T) -> String,
                                pinnedID: String?,
                                lastContact: [String: Date]) -> [T] {
        items.sorted { a, b in
            let aID = id(a), bID = id(b)
            if let pinnedID, aID != bID {
                if aID == pinnedID { return true }
                if bID == pinnedID { return false }
            }
            switch (lastContact[aID], lastContact[bID]) {
            case let (x?, y?) where x != y: return x > y
            case (.some, .none): return true
            case (.none, .some): return false
            default:
                let byName = name(a).localizedCaseInsensitiveCompare(name(b))
                return byName == .orderedSame ? aID < bID : byName == .orderedAscending
            }
        }
    }
}
