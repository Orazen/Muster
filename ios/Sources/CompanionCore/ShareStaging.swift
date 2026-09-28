import Foundation

/// One share, on its way from the share extension to the app.
///
/// The extension is a separate process that any other app on this phone can
/// influence indirectly, so the bundle is treated as untrusted input on the
/// way back in: every field is validated, the sizes are bounded before
/// anything is allocated for them, and a malformed bundle is dropped rather
/// than partially believed.
public struct StagedShare: Sendable, Hashable {
    /// Also the bundle's filename, so a re-read of the same file is
    /// recognisable and is not staged twice.
    public let id: UUID
    public let declaredText: Bool
    public let declaredLink: Bool
    public let receivedAt: Date
    public let candidates: [Data]

    public init(id: UUID, declaredText: Bool, declaredLink: Bool, receivedAt: Date, candidates: [Data]) {
        self.id = id; self.declaredText = declaredText; self.declaredLink = declaredLink
        self.receivedAt = receivedAt; self.candidates = candidates
    }
}

/// The wire format for the handoff, and the only filenames this app will read
/// out of the shared container.
public enum ShareStaging {
    /// Bounded so one bad or hostile bundle cannot make the app allocate
    /// without limit before it has decided anything about the content. The
    /// text cap that actually matters is `ShareLimits.maximumBytes`, applied
    /// after decode.
    public static let maximumBundleBytes = 1_048_576
    /// A share sheet offers a handful of attachments at most. More than this
    /// is a bug or an attempt, and only the first few could ever be used.
    public static let maximumCandidates = 8
    public static let filePrefix = "muster-share-"
    public static let fileSuffix = ".json"

    /// The one name a staged bundle may have. Deterministic in the id, so the
    /// writer and the reader cannot disagree about it.
    public static func filename(for id: UUID) -> String {
        filePrefix + id.uuidString + fileSuffix
    }

    /// Whether `name` is a staged-bundle filename this app is willing to
    /// open. Deliberately exact-match rather than "looks close": the app
    /// shares a container with its own extensions and nothing else, so an
    /// unexpected name there is something to ignore, not something to open.
    public static func stagedId(inFilename name: String) -> UUID? {
        guard name.hasPrefix(filePrefix), name.hasSuffix(fileSuffix) else { return nil }
        let middle = name.dropFirst(filePrefix.count).dropLast(fileSuffix.count)
        // `UUID(uuidString:)` accepts mixed case, so compare against the
        // canonical spelling to keep exactly one valid name per id.
        guard let id = UUID(uuidString: String(middle)), filename(for: id) == name else { return nil }
        return id
    }

    public static func encode(_ share: StagedShare) -> Data? {
        guard share.candidates.count <= maximumCandidates else { return nil }
        // Both sides of this handoff are this one file, so JSONEncoder's
        // default date strategy is fine and cannot drift between them.
        struct Body: Encodable {
            let id: UUID
            let declaredText: Bool
            let declaredLink: Bool
            let receivedAt: Date
            let candidates: [String]
        }
        let body = Body(id: share.id, declaredText: share.declaredText, declaredLink: share.declaredLink,
                        receivedAt: share.receivedAt,
                        candidates: share.candidates.map { $0.base64EncodedString() })
        return try? JSONEncoder().encode(body)
    }

    /// Returns nil for anything this app will not act on: not JSON, not this
    /// shape, over the size bound, or carrying an id that is not a UUID.
    /// `maximumBytes` is injectable so the bound itself is covered.
    public static func decode(_ data: Data, maximumBytes: Int = ShareStaging.maximumBundleBytes) -> StagedShare? {
        guard !data.isEmpty, data.count <= maximumBytes else { return nil }
        struct Body: Decodable {
            let id: UUID
            let declaredText: Bool
            let declaredLink: Bool
            let receivedAt: Date
            let candidates: [String]
        }
        guard let body = try? JSONDecoder().decode(Body.self, from: data),
              body.candidates.count <= maximumCandidates else { return nil }
        // A declared type with no bytes is a legitimate degenerate share; the
        // intake reports it as empty. Undecodable bytes are not legitimate, so
        // a base64 failure drops the bundle rather than staging a hole.
        var candidates: [Data] = []
        for encoded in body.candidates {
            guard let bytes = Data(base64Encoded: encoded) else { return nil }
            candidates.append(bytes)
        }
        return StagedShare(id: body.id, declaredText: body.declaredText, declaredLink: body.declaredLink,
                           receivedAt: body.receivedAt, candidates: candidates)
    }

    public static func payload(_ share: StagedShare) -> SharePayload {
        SharePayload(declaredText: share.declaredText, declaredLink: share.declaredLink,
                      candidates: share.candidates)
    }
}
