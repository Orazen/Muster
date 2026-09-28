import Foundation

/// What the share sheet actually handed over. A provider is untrusted input:
/// every flag here is something the *sending* app declared about its own
/// attachment, and every byte is whatever the load callback returned, which
/// may be text, a photograph, an archive, or nothing at all. The extension
/// does the UIKit unwrapping; every accept-or-refuse decision is made here so
/// that it is covered by `swift test` rather than by a device.
public struct SharePayload: Sendable {
    /// An attachment declared a textual type (`public.text`, UTF-8 plain
    /// text, RTF, HTML). Declaring it is a claim, not a guarantee.
    public let declaredText: Bool
    /// An attachment declared a URL or file reference. Accepted, but only as
    /// its textual absolute form — this app has no importer for the document
    /// a URL might point at, and guessing one is how a share turns into an
    /// arbitrary file write.
    public let declaredLink: Bool
    /// Bytes the extension managed to load, in the order the system offered
    /// them. First acceptable candidate wins; the rest are dropped rather
    /// than concatenated, because no share sheet means for a single item to
    /// be "both" a note and a link.
    public let candidates: [Data]

    public init(declaredText: Bool, declaredLink: Bool, candidates: [Data]) {
        self.declaredText = declaredText; self.declaredLink = declaredLink; self.candidates = candidates
    }
}

/// One accepted share, staged and not yet sent.
public struct SharedText: Sendable, Hashable, Identifiable {
    public let id: UUID
    /// Verbatim as shared, whitespace included. Trimming here would change
    /// what the person chose to share; `ComposerText.normalized` is applied
    /// on the wire, exactly as it is for a hand-typed draft.
    public let text: String
    public let receivedAt: Date

    public init(id: UUID = UUID(), text: String, receivedAt: Date) {
        self.id = id; self.text = text; self.receivedAt = receivedAt
    }
}

/// The outcome of sending a staged share into a conversation. `joined` is the
/// exact text the composer field should be given; the caller routes it
/// through `ComposerCoordinator.edit`, so the draft's revision counter moves
/// and the existing Send fence is untouched.
public enum ShareRoute: Sendable, Hashable {
    /// The composer was empty, so the shared text is the whole draft.
    case prefilled(SharedText, joined: String)
    /// The composer already held a draft. That draft survives: the shared
    /// text is appended below it after a blank line. Losing someone's
    /// half-written message to an incoming share is the one outcome this
    /// design exists to prevent.
    case appended(SharedText, joined: String)

    public var item: SharedText {
        switch self { case let .prefilled(item, _), let .appended(item, _): item }
    }
    public var joined: String {
        switch self { case let .prefilled(_, joined), let .appended(_, joined): joined }
    }
}

/// The bounds on a share, in one nonisolated place so the intake, the
/// staging codec and the share extension can all read them without hopping
/// through the main actor.
public enum ShareLimits {
    /// A share sheet item is a note-to-self or a quote. Anything much larger
    /// than this is a document, and this app has no reader for documents.
    /// Counted in UTF-8 bytes rather than characters, because that is the
    /// unit the wire and the composer's own body guard are measured in.
    public static let maximumBytes = 8_192
    /// Bounded so shares arriving while nobody is looking cannot grow the
    /// queue without limit.
    public static let capacity = 8
    /// What goes between an existing draft and an arriving share: a blank
    /// line, so the boundary stays visible in the field.
    public static let separator = "\n\n"
}

/// Inbound share intake.
///
/// Why a share is *staged* and never sent: `ComposerCoordinator` refuses to
/// send without a foreground scene and a live view lease, and that fencing
/// exists because a message in a bot's thread is an instruction the bot will
/// act on. Text arriving from another app is unvetted, and the person
/// sharing it may not be looking at Muster at all. So a share becomes a
/// prefilled, editable draft that the owner still presses Send on. Everything
/// past that press is the existing composer path, unchanged — including the
/// `messageSendVersion` preflight, the 1 MB encoded-body guard, and the rule
/// that a draft clears only on a verified 202 for the exact revision sent.
@MainActor
public final class ShareIntake {
    public enum Rejection: Error, Sendable, Hashable {
        /// No attachment was text or a link. A photo or a spreadsheet has no
        /// destination here, and the person deserves to be told rather than
        /// left guessing why nothing appeared.
        case unsupported
        /// Text was declared but nothing decoded, or it was only whitespace.
        case empty
        /// Past `ShareLimits.maximumBytes`. Refused rather than truncated: a
        /// truncated quote can still be a lie about what was shared.
        case tooLarge(bytes: Int)
        /// The queue is full. The *new* share is refused, not the oldest
        /// staged one — the oldest may be a message the owner has not seen.
        case capacityFull
        /// This exact share is already staged in this session. The extension
        /// can leave its staged bundle on disk after the app has read it, so
        /// re-reading on the next foreground is expected — and must not paste
        /// the same words into the composer a second time.
        case alreadyStaged
        /// No paired session. See `bind` for why this matters.
        case notPaired
        /// The target is no longer a live conversation, so the send could not
        /// be fenced. The item stays staged; retry once the roster settles.
        case targetUnavailable

        public var reason: String {
            switch self {
            case .unsupported: return "Muster only accepts shared text."
            case .empty: return "There was no text in that share."
            case .tooLarge: return "That share is too long to send as a message. Copy the part you want into a conversation instead."
            case .capacityFull: return "There are shared messages waiting already. Send or discard one first."
            case .alreadyStaged: return "That share is already waiting to be sent."
            case .notPaired: return "Pair this phone with a computer before sending shared text."
            case .targetUnavailable: return "That conversation isn't available yet. Try again in a moment."
            }
        }
    }

    public private(set) var items: [SharedText] = []
    /// The last refusal worth telling the owner about. A share that vanishes
    /// with no explanation is the failure mode people report as "sharing is
    /// broken", so the reason is surfaced rather than swallowed.
    /// `.alreadyStaged` is a normal re-read of a bundle the app has already
    /// seen, and `.notPaired` has no composer to sit in front of, so neither
    /// becomes a notice.
    public private(set) var notice: String?
    private var consumed: Set<UUID> = []
    private var sessionId: UUID?
    private let capacity: Int
    private let maximumBytes: Int
    private let readState: () -> CompanionState
    private let changed: ([SharedText]) -> Void
    private let noticeChanged: (String?) -> Void

    private func publish() {
        changed(items)
        noticeChanged(notice)
    }

    public init(readState: @escaping () -> CompanionState,
                changed: @escaping ([SharedText]) -> Void = { _ in },
                noticeChanged: @escaping (String?) -> Void = { _ in },
                capacity: Int = ShareLimits.capacity,
                maximumBytes: Int = ShareLimits.maximumBytes) {
        self.readState = readState
        self.changed = changed
        self.noticeChanged = noticeChanged
        self.capacity = max(1, capacity)
        self.maximumBytes = max(1, maximumBytes)
    }

    /// Staged text belongs to the pairing that was live when it arrived. A
    /// rebind means a different computer (or none), and a note the owner
    /// shared while looking at computer A must not surface as a draft in a
    /// conversation on computer B. So the queue is dropped, not migrated —
    /// and `receive` refuses outright while unpaired.
    public func bind(sessionId: UUID?) {
        guard self.sessionId != sessionId else { return }
        self.sessionId = sessionId
        items = []; consumed = []; notice = nil
        publish()
    }

    public var isPaired: Bool { sessionId != nil }

    /// Decode and stage one share. Returns the staged item, or the reason it
    /// was refused. Never sends anything and never touches a composer.
    ///
    /// `id` should be the identifier of the *staged bundle* on disk when there
    /// is one, not a fresh value per call. That is what makes `alreadyStaged`
    /// reachable: the extension writes the bundle once, the app may read it
    /// again on every foreground, and the words must be staged once. Callers
    /// with no on-disk bundle (a test, or a future in-process source) can take
    /// the default and get a fresh item each time.
    @discardableResult
    public func receive(_ payload: SharePayload, receivedAt: Date = Date(), id: UUID = UUID())
        -> Result<SharedText, Rejection> {
        guard sessionId != nil else { return .failure(.notPaired) }
        guard payload.declaredText || payload.declaredLink else { return .failure(.unsupported) }
        guard !consumed.contains(id), !items.contains(where: { $0.id == id }) else { return .failure(.alreadyStaged) }
        guard items.count < capacity else { return .failure(.capacityFull) }

        var sawOversize = 0
        for candidate in payload.candidates {
            // Strict UTF-8: a provider may return Latin-1 or a truncated
            // multi-byte sequence, and `String(decoding:as:)` would replace
            // the bad bytes with U+FFFD, quietly sending text the person
            // never shared.
            guard let text = String(data: candidate, encoding: .utf8) else { continue }
            guard !ComposerText.normalized(text).isEmpty else { continue }
            let bytes = candidate.count
            guard bytes <= maximumBytes else { sawOversize = max(sawOversize, bytes); continue }
            let item = SharedText(id: id, text: text, receivedAt: receivedAt)
            items.append(item)
            publish()
            return .success(item)
        }
        if sawOversize > 0 { return .failure(.tooLarge(bytes: sawOversize)) }
        // A declared type with nothing loadable behind it is the common
        // degenerate share, and it reads as "empty" rather than
        // "unsupported" because a text attachment really was offered.
        return .failure(.empty)
    }

    /// Turn a staged item into the text a conversation's composer should
    /// hold, and consume it. Returns `nil` — leaving the item staged — when
    /// the target is not a live conversation, so a share that lands before
    /// the roster has loaded is never silently swallowed.
    public func route(_ id: UUID, for context: ComposerContext, existingDraft: String) -> ShareRoute? {
        guard context.sessionId == sessionId, let index = items.firstIndex(where: { $0.id == id }),
              !consumed.contains(id), context.target.isCurrent(in: readState()) else { return nil }
        let item = items[index]
        items.remove(at: index)
        consumed.insert(id)
        publish()
        // A draft that is only whitespace is not a draft. Prefilling over it
        // would discard typed characters on the strength of a guess.
        if ComposerText.normalized(existingDraft).isEmpty {
            return .prefilled(item, joined: item.text)
        }
        return .appended(item, joined: existingDraft + ShareLimits.separator + item.text)
    }

    /// Drop a staged item without sending it.
    public func discard(_ id: UUID) {
        if let index = items.firstIndex(where: { $0.id == id }) { items.remove(at: index) }
        consumed.insert(id)
        publish()
    }

    /// Surface a refusal the owner should know about. Two rejections are
    /// deliberately silent: a re-read of a bundle already seen, and a share
    /// that arrived while unpaired (the roster has no composer to show it in,
    /// and the next foreground will offer it again).
    public func report(_ rejection: Rejection) {
        switch rejection {
        case .alreadyStaged, .notPaired: notice = nil
        default: notice = rejection.reason
        }
        publish()
    }

    public func clearNotice() {
        notice = nil
        publish()
    }
}
