import Foundation

public protocol IdeaRepository: Sendable {
    func listIdeas(teamID: String) async throws -> [IdeaRecord]
    func createIdea(teamID: String, input: IdeaCreateInput) async throws -> IdeaRecord
    func updateIdea(ideaID: String, input: IdeaUpdateInput) async throws -> IdeaRecord
    func setArchived(ideaID: String, archived: Bool) async throws -> IdeaRecord
    func reorderIdeas(teamID: String, ideaIDs: [String]) async throws
    func listIdeaActivities(ideaID: String) async throws -> [IdeaActivityRecord]
    func createIdeaActivity(ideaID: String, input: IdeaActivityCreateInput) async throws -> IdeaActivityRecord
    /// Sets whether the caller likes this idea. Deliberately not a toggle —
    /// the caller says what the state should be, so a retry or a second
    /// device settles on the same answer instead of undoing the first tap.
    func setIdeaLike(ideaID: String, liked: Bool) async throws -> IdeaLikeState
}

public enum IdeaRepositoryError: LocalizedError {
    case missingTitle
    case emptyResponse(String)

    public var errorDescription: String? {
        switch self {
        case .missingTitle:
            return "Title is required."
        case .emptyResponse(let functionName):
            return "\(functionName) returned no rows."
        }
    }
}
