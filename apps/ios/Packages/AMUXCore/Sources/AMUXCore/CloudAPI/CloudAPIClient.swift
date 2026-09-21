import Foundation

public enum CloudAPIError: LocalizedError, Sendable {
    case missingAccessToken
    case invalidResponse
    case requestFailed(status: Int, code: String?, message: String)

    public var errorDescription: String? {
        switch self {
        case .missingAccessToken:
            return "Missing Cloud API bearer token."
        case .invalidResponse:
            return "Cloud API returned an invalid response."
        case let .requestFailed(_, _, message):
            return message
        }
    }
}

public typealias CloudAPISend = @Sendable (URLRequest) async throws -> (Data, HTTPURLResponse)

public struct CloudAPIClient: Sendable {
    public let baseURL: URL
    private let accessToken: @Sendable () async throws -> String
    private let send: CloudAPISend

    public init(
        configuration: CloudAPIConfiguration,
        accessToken: @escaping @Sendable () async throws -> String,
        send: @escaping CloudAPISend = CloudAPIClient.urlSessionSend
    ) {
        self.baseURL = configuration.baseURL
        self.accessToken = accessToken
        self.send = send
    }

    public func get<T: Decodable & Sendable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        try await request("GET", path: path, body: Optional<Data>.none, idempotencyKey: nil, as: type)
    }

    public func post<Body: Encodable & Sendable, T: Decodable & Sendable>(
        _ path: String,
        body: Body,
        idempotencyKey: String? = nil,
        as type: T.Type = T.self
    ) async throws -> T {
        let data = try JSONEncoder().encode(body)
        return try await request("POST", path: path, body: data, idempotencyKey: idempotencyKey, as: type)
    }

    public func postVoid<Body: Encodable & Sendable>(
        _ path: String,
        body: Body,
        idempotencyKey: String? = nil
    ) async throws {
        let data = try JSONEncoder().encode(body)
        try await requestVoid("POST", path: path, body: data, idempotencyKey: idempotencyKey)
    }

    public func patch<Body: Encodable & Sendable, T: Decodable & Sendable>(
        _ path: String,
        body: Body,
        idempotencyKey: String? = nil,
        as type: T.Type = T.self
    ) async throws -> T {
        let data = try JSONEncoder().encode(body)
        return try await request("PATCH", path: path, body: data, idempotencyKey: idempotencyKey, as: type)
    }

    public func deleteVoid(_ path: String) async throws {
        try await requestVoid("DELETE", path: path, body: Optional<Data>.none, idempotencyKey: nil)
    }

    public func putVoid<Body: Encodable & Sendable>(
        _ path: String,
        body: Body,
        idempotencyKey: String? = nil
    ) async throws {
        let data = try JSONEncoder().encode(body)
        try await requestVoid("PUT", path: path, body: data, idempotencyKey: idempotencyKey)
    }

    public func put<Body: Encodable & Sendable, T: Decodable & Sendable>(
        _ path: String,
        body: Body,
        idempotencyKey: String? = nil,
        as type: T.Type = T.self
    ) async throws -> T {
        let data = try JSONEncoder().encode(body)
        return try await request("PUT", path: path, body: data, idempotencyKey: idempotencyKey, as: type)
    }

    /// POST raw bytes (e.g. an octet-stream upload) and decode the JSON result.
    public func postRaw<T: Decodable & Sendable>(
        _ path: String,
        bytes: Data,
        contentType: String,
        as type: T.Type = T.self
    ) async throws -> T {
        try await request("POST", path: path, body: bytes, idempotencyKey: nil, as: type, contentType: contentType)
    }

    /// GET raw bytes plus the server's content type.
    ///
    /// For `GET /v1/attachments/:path`, which answers with the file itself
    /// rather than JSON. The route is caller-scoped, so the bytes can only be
    /// fetched with the user's bearer — an `AsyncImage` pointed at that URL
    /// gets a 401. The attachments bucket is public, but iOS is never told
    /// the storage origin (only the Cloud API's), so there is no public URL
    /// to build either.
    public func getRawBytes(_ path: String) async throws -> (data: Data, contentType: String) {
        let token = try await accessToken().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw CloudAPIError.missingAccessToken }

        let normalizedBase = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        guard let url = URL(string: "\(normalizedBase)\(normalizedPath)") else {
            throw CloudAPIError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(Self.requestID(), forHTTPHeaderField: "X-Request-Id")

        let (data, response) = try await send(request)
        guard (200..<300).contains(response.statusCode) else {
            let envelope = try? JSONDecoder().decode(CloudAPIErrorEnvelope.self, from: data)
            throw CloudAPIError.requestFailed(
                status: response.statusCode,
                code: envelope?.error.code,
                message: envelope?.error.message ?? HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
            )
        }
        let mime = response.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
        return (data, mime)
    }

    public func patchVoid<Body: Encodable & Sendable>(
        _ path: String,
        body: Body,
        idempotencyKey: String? = nil
    ) async throws {
        let data = try JSONEncoder().encode(body)
        try await requestVoid("PATCH", path: path, body: data, idempotencyKey: idempotencyKey)
    }

    private func request<T: Decodable & Sendable>(
        _ method: String,
        path: String,
        body: Data?,
        idempotencyKey: String?,
        as type: T.Type,
        contentType: String = "application/json"
    ) async throws -> T {
        let token = try await accessToken().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw CloudAPIError.missingAccessToken }

        let normalizedBase = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        guard let url = URL(string: "\(normalizedBase)\(normalizedPath)") else {
            throw CloudAPIError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(Self.requestID(), forHTTPHeaderField: "X-Request-Id")
        if let idempotencyKey {
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        if let body {
            request.httpBody = body
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await send(request)
        guard (200..<300).contains(response.statusCode) else {
            let envelope = try? JSONDecoder().decode(CloudAPIErrorEnvelope.self, from: data)
            throw CloudAPIError.requestFailed(
                status: response.statusCode,
                code: envelope?.error.code,
                message: envelope?.error.message ?? HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
            )
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func requestVoid(
        _ method: String,
        path: String,
        body: Data?,
        idempotencyKey: String?
    ) async throws {
        let token = try await accessToken().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw CloudAPIError.missingAccessToken }

        let normalizedBase = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        guard let url = URL(string: "\(normalizedBase)\(normalizedPath)") else {
            throw CloudAPIError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(Self.requestID(), forHTTPHeaderField: "X-Request-Id")
        if let idempotencyKey {
            request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await send(request)
        guard (200..<300).contains(response.statusCode) else {
            let envelope = try? JSONDecoder().decode(CloudAPIErrorEnvelope.self, from: data)
            throw CloudAPIError.requestFailed(
                status: response.statusCode,
                code: envelope?.error.code,
                message: envelope?.error.message ?? HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
            )
        }
    }

    public static let urlSessionSend: CloudAPISend = { request in
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw CloudAPIError.invalidResponse }
        return (data, http)
    }

    private static func requestID() -> String {
        UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}

private struct CloudAPIErrorEnvelope: Decodable {
    let error: CloudAPIErrorBody
}

private struct CloudAPIErrorBody: Decodable {
    let code: String
    let message: String
}
