// Local-first status is a read-only mirror, not a second database.
//
// The phone already receives the fleet and transcript pages from the
// computer. This file projects the computer's existing storage capability and
// automatic-snapshot status into a small report the companion UI can render.
// It intentionally keeps provider ids, filenames, paths, errors, history,
// passphrase state and credentials out of memory: a status row should answer
// "where does the computer keep this, and what did it last verify?" without
// turning a lost phone into a second copy of the workspace.
import Foundation

// MARK: - Storage destination

/// The active destination vocabulary used by the phone and watch. The server
/// may add another provider later; an older companion reports "unknown"
/// instead of guessing that an unrecognized destination is Drive or Telegram.
public enum StorageDestination: String, Sendable, Equatable {
    case computerOnly
    case googleDriveComputer
    case googleDriveAccount
    case unknown
    case unavailable

    public var displayName: String {
        switch self {
        case .computerOnly: return "This computer only"
        case .googleDriveComputer: return "Google Drive · this computer"
        case .googleDriveAccount: return "Google Drive · this account"
        case .unknown: return "Destination not reported"
        case .unavailable: return "Unavailable on this computer"
        }
    }
}

/// The subset of `WorkspaceBackupCapability` a companion needs. Fields remain
/// optional at the wire boundary so a future capability field does not erase
/// the whole row; the computed destination never infers one from its presence.
public struct WorkspaceBackupCapability: Codable, Sendable, Equatable {
    public var capabilityVersion: Int?
    public var workspaceBackupAvailable: Bool?
    public var drive: Bool?
    public var installationDrive: DriveAvailability?
    public var accountDrive: AccountDriveAvailability?

    public init(
        capabilityVersion: Int? = nil,
        workspaceBackupAvailable: Bool? = nil,
        drive: Bool? = nil,
        installationDrive: DriveAvailability? = nil,
        accountDrive: AccountDriveAvailability? = nil
    ) {
        self.capabilityVersion = capabilityVersion
        self.workspaceBackupAvailable = workspaceBackupAvailable
        self.drive = drive
        self.installationDrive = installationDrive
        self.accountDrive = accountDrive
    }

    private enum CodingKeys: String, CodingKey {
        case capabilityVersion, workspaceBackupAvailable, drive
        case installationDrive, accountDrive
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        capabilityVersion = try container.decodeIfPresent(Int.self, forKey: .capabilityVersion)
        workspaceBackupAvailable = try container.decodeIfPresent(Bool.self, forKey: .workspaceBackupAvailable)
        drive = try container.decodeIfPresent(Bool.self, forKey: .drive)
        installationDrive = try container.decodeIfPresent(DriveAvailability.self, forKey: .installationDrive)
        accountDrive = try container.decodeIfPresent(AccountDriveAvailability.self, forKey: .accountDrive)
    }

    /// Only an explicitly usable transport becomes a destination. A partial
    /// future object is not evidence that the workspace is safely on this
    /// computer, and account Drive is checked first because the installation
    /// backup flag can be false on a hosted control plane while the signed-in
    /// user's own Drive is connected.
    public var storageDestination: StorageDestination {
        if accountDrive?.available == true, accountDrive?.connected == true {
            return .googleDriveAccount
        }
        if installationDrive?.operationsAvailable == true || drive == true {
            return .googleDriveComputer
        }
        if workspaceBackupAvailable == true { return .computerOnly }
        if workspaceBackupAvailable == false { return .unavailable }
        return .unknown
    }
}

public struct DriveAvailability: Codable, Sendable, Equatable {
    public var configured: Bool?
    public var operationsAvailable: Bool?

    public init(configured: Bool? = nil, operationsAvailable: Bool? = nil) {
        self.configured = configured
        self.operationsAvailable = operationsAvailable
    }

    private enum CodingKeys: String, CodingKey {
        case configured, operationsAvailable
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        configured = try container.decodeIfPresent(Bool.self, forKey: .configured)
        operationsAvailable = try container.decodeIfPresent(Bool.self, forKey: .operationsAvailable)
    }
}

public struct AccountDriveAvailability: Codable, Sendable, Equatable {
    public var available: Bool?
    public var connected: Bool?

    public init(available: Bool? = nil, connected: Bool? = nil) {
        self.available = available
        self.connected = connected
    }

    private enum CodingKeys: String, CodingKey {
        case available, connected
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        available = try container.decodeIfPresent(Bool.self, forKey: .available)
        connected = try container.decodeIfPresent(Bool.self, forKey: .connected)
    }
}

// MARK: - Snapshot status

public enum LocalSnapshotOutcome: String, Decodable, Sendable, Equatable {
    case success
    case failed
    case skipped
    case unknown

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        self = LocalSnapshotOutcome(rawValue: raw) ?? .unknown
    }
}

/// The small, safe projection of the existing snapshot-policy response.
///
/// The server also returns the passphrase-store decision, run errors and full
/// history. Those can name providers or filesystem details and are useful on
/// the computer, not on a companion. The phone keeps only timestamps and the
/// outcome it needs to render an honest headline.
public struct LocalSnapshotStatus: Decodable, Sendable, Equatable {
    public var lastAttemptAt: Double?
    public var lastSuccessAt: Double?
    public var lastOutcome: LocalSnapshotOutcome?
    public var lastVerifiedAt: Double?

    public init(
        lastAttemptAt: Double? = nil,
        lastSuccessAt: Double? = nil,
        lastOutcome: LocalSnapshotOutcome? = nil,
        lastVerifiedAt: Double? = nil
    ) {
        self.lastAttemptAt = lastAttemptAt
        self.lastSuccessAt = lastSuccessAt
        self.lastOutcome = lastOutcome
        self.lastVerifiedAt = lastVerifiedAt
    }

    private enum CodingKeys: String, CodingKey {
        case health, runs
    }

    private struct Health: Decodable {
        var verifiedAt: Double

        private enum CodingKeys: String, CodingKey { case verifiedAt }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            verifiedAt = try container.decode(Double.self, forKey: .verifiedAt)
        }
    }

    private struct Runs: Decodable {
        var lastAttemptAt: Double?
        var lastSuccessAt: Double?
        var lastOutcome: LocalSnapshotOutcome?

        private enum CodingKeys: String, CodingKey {
            case lastAttemptAt, lastSuccessAt, lastOutcome
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            lastAttemptAt = try container.decodeIfPresent(Double.self, forKey: .lastAttemptAt)
            lastSuccessAt = try container.decodeIfPresent(Double.self, forKey: .lastSuccessAt)
            lastOutcome = try container.decodeIfPresent(LocalSnapshotOutcome.self, forKey: .lastOutcome)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let health = try container.decodeIfPresent(Health.self, forKey: .health)
        let runs = try container.decodeIfPresent(Runs.self, forKey: .runs)
        lastAttemptAt = runs?.lastAttemptAt
        lastSuccessAt = runs?.lastSuccessAt
        lastOutcome = runs?.lastOutcome
        lastVerifiedAt = health?.verifiedAt
    }
}

// MARK: - The computer's own receipt

/// `GET /api/workspace/companion/status` — the computer's authoritative,
/// read-only statement about itself: where storage lives, the last snapshot
/// facts, and when conversations last pushed or pulled (Loop199, after P4
/// made conversation sync real in Loop197).
///
/// Older computers do not answer this route, and a future computer may add
/// destinations this build has never heard of. Every field is therefore
/// optional, an unrecognized destination decodes to `nil` rather than a
/// guess, and a missing receipt leaves the capability-derived view exactly
/// as it was — the phone degrades to the older two-endpoint story rather
/// than showing an error.
///
/// Like everything else in this file it carries no path, provider id or
/// name, token, passphrase state, error text or history: a status row is
/// not a second copy of the workspace.
public struct CompanionReceipt: Codable, Sendable, Equatable {
    public struct Backup: Codable, Sendable, Equatable {
        public var lastAttemptAt: Double?
        public var lastSuccessAt: Double?
        public var lastOutcome: String?
        public var lastVerifiedAt: Double?
    }

    public struct ConversationSync: Codable, Sendable, Equatable {
        public var lastPushAt: Double?
        public var lastPullAt: Double?
        public var lastOutcome: String?
    }

    public var version: Int?
    public var storageDestination: String?
    public var backup: Backup?
    public var conversationSync: ConversationSync?

    public init(
        version: Int? = nil,
        storageDestination: String? = nil,
        backup: Backup? = nil,
        conversationSync: ConversationSync? = nil
    ) {
        self.version = version
        self.storageDestination = storageDestination
        self.backup = backup
        self.conversationSync = conversationSync
    }

    /// The computer's destination, mapped explicitly. An unknown future
    /// value is `nil`, which sends the UI back to the capability-derived
    /// answer rather than pretending this build understands the computer.
    public var destination: StorageDestination? {
        switch storageDestination {
        case "computer": return .computerOnly
        case "google-drive-computer": return .googleDriveComputer
        case "google-drive-account": return .googleDriveAccount
        case "unavailable": return .unavailable
        case "unknown": return .unknown
        default: return nil
        }
    }
}

// MARK: - Aggregate report

/// A point-in-time report assembled by the client. It is not persisted and is
/// replaced whenever the computer is refreshed. The computer remains the
/// source of the workspace and of every storage fact shown here.
public struct LocalFirstStatus: Sendable, Equatable {
    public let capability: WorkspaceBackupCapability
    public let snapshot: LocalSnapshotStatus?
    public let snapshotStatusUnavailable: Bool
    /// The computer's own receipt when it answers the route; nil on an older
    /// computer, where the capability-derived view below still stands.
    public let receipt: CompanionReceipt?
    public let fetchedAt: Date

    public init(
        capability: WorkspaceBackupCapability,
        snapshot: LocalSnapshotStatus? = nil,
        snapshotStatusUnavailable: Bool = false,
        receipt: CompanionReceipt? = nil,
        fetchedAt: Date = Date()
    ) {
        self.capability = capability
        self.snapshot = snapshot
        self.snapshotStatusUnavailable = snapshotStatusUnavailable
        self.receipt = receipt
        self.fetchedAt = fetchedAt
    }

    /// The computer's own word wins: it owns the workspace, and the receipt
    /// is derived from the same capability computation the advertisement
    /// route uses. The capability-derived value remains the answer for a
    /// computer that does not answer the receipt route at all.
    public var storageDestination: StorageDestination {
        receipt?.destination ?? capability.storageDestination
    }

    /// Deliberately does not fall back to `lastSuccessAt`: a successful upload
    /// and a completed download-and-verify round trip are different facts.
    public var lastVerifiedSnapshotAt: Double? {
        if let value = positive(receipt?.backup?.lastVerifiedAt) { return value }
        guard let value = positive(snapshot?.lastVerifiedAt) else { return nil }
        return value
    }

    public var lastSuccessfulSnapshotAt: Double? {
        positive(receipt?.backup?.lastSuccessAt) ?? positive(snapshot?.lastSuccessAt)
    }

    public var lastAttemptAt: Double? {
        positive(receipt?.backup?.lastAttemptAt) ?? positive(snapshot?.lastAttemptAt)
    }

    // MARK: Conversation sync (the Loop199 receipt)

    /// True only when the computer actually reported conversation-sync
    /// facts. "Not reported" and "reported unknown" are different sentences
    /// and the UI keeps them apart.
    public var conversationSyncReported: Bool {
        receipt?.conversationSync != nil
    }

    public var lastConversationPushAt: Double? {
        positive(receipt?.conversationSync?.lastPushAt)
    }

    public var lastConversationPullAt: Double? {
        positive(receipt?.conversationSync?.lastPullAt)
    }

    public var conversationSyncOutcome: String? {
        receipt?.conversationSync?.lastOutcome
    }

    /// Zero is the wire's "never happened" and NaN/negative is nonsense —
    /// both read as absent, never as a date.
    private func positive(_ value: Double?) -> Double? {
        guard let unwrapped = value, unwrapped.isFinite, unwrapped > 0 else { return nil }
        return unwrapped
    }
}

// MARK: - What this companion can currently see

/// A local projection of already-loaded companion state. This is deliberately
/// a visibility summary, not a stored copy: it describes the pages currently
/// held by the app and never claims that the phone owns the workspace.
public struct LocalDataSummary: Sendable, Equatable {
    public let botCount: Int
    public let roomCount: Int
    public let threadCount: Int
    public let messageCount: Int
    public let approvalCount: Int
    public let lastActivityAt: Double?

    public init(
        botCount: Int = 0,
        roomCount: Int = 0,
        threadCount: Int = 0,
        messageCount: Int = 0,
        approvalCount: Int = 0,
        lastActivityAt: Double? = nil
    ) {
        self.botCount = botCount
        self.roomCount = roomCount
        self.threadCount = threadCount
        self.messageCount = messageCount
        self.approvalCount = approvalCount
        self.lastActivityAt = lastActivityAt
    }

    public init(state: CompanionState) {
        let visibleBots = state.bots.filter { $0.hidden != true }
        let threadIds = Set(visibleBots.map(\.threadId)).union(state.rooms.map(\.threadId))
        var messageCount = 0
        var latestActivity: Double = 0
        for threadId in threadIds {
            let messages = state.transcript(forThread: threadId)
            messageCount += messages.count
            latestActivity = max(latestActivity, messages.lazy.map(\.at).max() ?? 0)
        }

        self.init(
            botCount: visibleBots.count,
            roomCount: state.rooms.count,
            threadCount: threadIds.count,
            messageCount: messageCount,
            approvalCount: state.pendingApprovals.count,
            lastActivityAt: latestActivity > 0 ? latestActivity : nil
        )
    }
}
