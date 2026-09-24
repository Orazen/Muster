import XCTest
@testable import CompanionCore

private final class LocalFirstHTTPPlan: @unchecked Sendable {
    struct Response {
        let status: Int
        let body: Data
    }

    private let lock = NSLock()
    private var responses: [Response?]
    private var captured: [URLRequest] = []

    init(_ responses: [Response?]) {
        self.responses = responses
    }

    func next(_ request: URLRequest) -> Response? {
        lock.lock()
        defer { lock.unlock() }
        captured.append(request)
        return responses.isEmpty ? Response(status: 500, body: Data()) : responses.removeFirst()
    }

    var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return captured
    }
}

private final class LocalFirstHTTPRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var plans: [String: LocalFirstHTTPPlan] = [:]

    func set(_ host: String, _ plan: LocalFirstHTTPPlan?) {
        lock.lock()
        defer { lock.unlock() }
        plans[host] = plan
    }

    func get(_ host: String) -> LocalFirstHTTPPlan? {
        lock.lock()
        defer { lock.unlock() }
        return plans[host]
    }
}

private final class LocalFirstHTTPProtocol: URLProtocol {
    static let registry = LocalFirstHTTPRegistry()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let plan = Self.registry.get(url.host ?? "") else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        guard let response = plan.next(request) else { return }
        client?.urlProtocol(
            self,
            didReceive: HTTPURLResponse(
                url: url,
                statusCode: response.status,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!,
            cacheStoragePolicy: .notAllowed
        )
        client?.urlProtocol(self, didLoad: response.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class LocalFirstStatusTests: XCTestCase {
    private var sessions: [URLSession] = []
    private var hosts: [String] = []

    override func tearDown() {
        for session in sessions { session.invalidateAndCancel() }
        for host in hosts { LocalFirstHTTPProtocol.registry.set(host, nil) }
        sessions = []
        hosts = []
        super.tearDown()
    }

    private func response(_ body: String, status: Int = 200) -> LocalFirstHTTPPlan.Response {
        LocalFirstHTTPPlan.Response(status: status, body: Data(body.utf8))
    }

    private func client(_ responses: [LocalFirstHTTPPlan.Response?]) -> (CompanionClient, LocalFirstHTTPPlan, String) {
        let host = UUID().uuidString.lowercased() + ".invalid"
        let plan = LocalFirstHTTPPlan(responses)
        LocalFirstHTTPProtocol.registry.set(host, plan)
        hosts.append(host)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [LocalFirstHTTPProtocol.self]
        let session = URLSession(configuration: configuration)
        sessions.append(session)
        let token = UUID().uuidString
        return (
            CompanionClient(
                connection: Connection(name: "Owned fixture", host: host, port: 8810),
                token: token,
                session: session
            ),
            plan,
            token
        )
    }

    func testClientReadsOnlyTheThreeComputerStatusRoutesAndProjectsSafeSnapshotFacts() async throws {
        let capability = #"""
        {
          "capabilityVersion":1,
          "workspaceBackupAvailable":true,
          "unavailableReason":null,
          "drive":false,
          "installationDrive":{"configured":true,"operationsAvailable":true},
          "accountDrive":{"available":true,"connected":true}
        }
        """#
        let receipt = #"""
        {
          "version":1,
          "storageDestination":"google-drive-account",
          "backup":{"lastAttemptAt":1800000100000,"lastSuccessAt":1800000100000,
                    "lastOutcome":"success","lastVerifiedAt":1800000000000},
          "conversationSync":{"lastPushAt":1800000300000,"lastPullAt":1800000400000,"lastOutcome":"success"}
        }
        """#
        let snapshot = #"""
        {
          "policy":{"nightlyEnabled":true,"retention":{"recent":7,"daily":7,"weekly":4,"monthly":6}},
          "store":{"status":"available","hasPassphrase":true},
          "driveConnected":true,
          "health":{"snapshotId":"provider-id","name":"provider-name","verifiedAt":1800000000000},
          "runs":{"lastAttemptAt":1800000100000,"lastSuccessAt":1800000100000,"lastOutcome":"success",
                  "lastError":null,"lastDetail":"sentinel-detail","consecutiveFailures":0},
          "history":[{"at":1800000100000,"reason":"nightly","outcome":"success","detail":"sentinel-history"}],
          "nextNightlyAt":1800000200000
        }
        """#
        let (client, plan, token) = client([response(capability), response(receipt), response(snapshot)])

        let report = try await client.localFirstStatus()

        XCTAssertEqual(report.storageDestination, .googleDriveAccount)
        XCTAssertEqual(report.lastVerifiedSnapshotAt, 1_800_000_000_000)
        XCTAssertEqual(report.lastSuccessfulSnapshotAt, 1_800_000_100_000)
        XCTAssertEqual(report.snapshot?.lastOutcome, .success)
        XCTAssertFalse(report.snapshotStatusUnavailable)
        XCTAssertFalse(String(describing: report.snapshot).contains("sentinel"))
        XCTAssertFalse(String(describing: report.snapshot).contains("provider-"))

        // Loop199: the computer's own receipt now answers for conversations.
        XCTAssertTrue(report.conversationSyncReported)
        XCTAssertEqual(report.lastConversationPushAt, 1_800_000_300_000)
        XCTAssertEqual(report.lastConversationPullAt, 1_800_000_400_000)
        XCTAssertEqual(report.conversationSyncOutcome, "success")

        XCTAssertEqual(plan.requests.map { $0.url?.path }, [
            "/api/workspace/google/status",
            "/api/workspace/companion/status",
            "/api/workspace/snapshots/policy",
        ])
        for request in plan.requests {
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.httpBody)
            XCTAssertEqual(request.cachePolicy, .reloadIgnoringLocalAndRemoteCacheData)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cache-Control"), "no-cache, no-store")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
        }
    }

    func testTheComputersOwnDestinationWinsAndAnUnknownFutureOneFallsBackToTheCapability() {
        let capability = WorkspaceBackupCapability(
            workspaceBackupAvailable: true,
            installationDrive: DriveAvailability(configured: true, operationsAvailable: true)
        )
        let receiptDestination = LocalFirstStatus(
            capability: capability,
            receipt: CompanionReceipt(storageDestination: "google-drive-account")
        )
        XCTAssertEqual(receiptDestination.storageDestination, .googleDriveAccount)

        // A destination this build has never heard of must not be guessed at:
        // the capability-derived answer stands until the phone learns the word.
        let future = LocalFirstStatus(
            capability: capability,
            receipt: CompanionReceipt(storageDestination: "future-cloud-vault")
        )
        XCTAssertEqual(future.storageDestination, .googleDriveComputer)
    }

    func testConversationSyncIsNotReportedWhenTheComputerSaysNothing() {
        let capability = WorkspaceBackupCapability(workspaceBackupAvailable: true)
        let withoutReceipt = LocalFirstStatus(capability: capability)
        XCTAssertFalse(withoutReceipt.conversationSyncReported)
        XCTAssertNil(withoutReceipt.lastConversationPushAt)
        XCTAssertNil(withoutReceipt.lastConversationPullAt)
        XCTAssertNil(withoutReceipt.conversationSyncOutcome)

        // Zero is the wire's "never happened" and must read as absent, not as
        // a date in 1970; a NaN is nonsense and reads the same way.
        let zeroes = LocalFirstStatus(
            capability: capability,
            receipt: CompanionReceipt(
                conversationSync: .init(lastPushAt: 0, lastPullAt: .nan, lastOutcome: "unknown")
            )
        )
        XCTAssertTrue(zeroes.conversationSyncReported)
        XCTAssertNil(zeroes.lastConversationPushAt)
        XCTAssertNil(zeroes.lastConversationPullAt)
        XCTAssertEqual(zeroes.conversationSyncOutcome, "unknown")
    }

    func testUnavailableWorkspaceStillReadsTheReceiptButNotTheInstallationSnapshotView() async throws {
        let capability = #"""
        {
          "capabilityVersion":1,
          "workspaceBackupAvailable":false,
          "unavailableReason":"not available here",
          "drive":false,
          "installationDrive":{"configured":false,"operationsAvailable":false},
          "accountDrive":{"available":false,"connected":false}
        }
        """#
        let receipt = #"""
        {
          "version":1,
          "storageDestination":"unavailable",
          "backup":{"lastAttemptAt":0,"lastSuccessAt":0,"lastOutcome":"unknown","lastVerifiedAt":0},
          "conversationSync":{"lastPushAt":1800000300000,"lastPullAt":0,"lastOutcome":"success"}
        }
        """#
        let (client, plan, _) = client([response(capability), response(receipt)])

        let report = try await client.localFirstStatus()

        XCTAssertEqual(report.storageDestination, .unavailable)
        XCTAssertNil(report.snapshot)
        XCTAssertFalse(report.snapshotStatusUnavailable)
        XCTAssertFalse(String(describing: report.capability).contains("not available here"))
        // A hosted computer still knows when its user's Drive last carried a
        // conversation, so the receipt is read before the availability guard.
        XCTAssertTrue(report.conversationSyncReported)
        XCTAssertEqual(report.lastConversationPushAt, 1_800_000_300_000)
        XCTAssertEqual(plan.requests.map { $0.url?.path }, [
            "/api/workspace/google/status",
            "/api/workspace/companion/status",
        ])
    }

    func testSnapshotFailureLeavesAUsefulPartialReportWithoutErrorText() async throws {
        let capability = #"""
        {
          "capabilityVersion":1,
          "workspaceBackupAvailable":true,
          "unavailableReason":null,
          "drive":false,
          "installationDrive":{"configured":true,"operationsAvailable":true},
          "accountDrive":{"available":false,"connected":false}
        }
        """#
        let (client, plan, _) = client([
            response(capability),
            response(#"{"error":"sentinel-receipt"}"#, status: 500),
            response(#"{"error":"sentinel-error"}"#, status: 500),
        ])

        let report = try await client.localFirstStatus()

        XCTAssertEqual(report.storageDestination, .googleDriveComputer)
        XCTAssertNil(report.receipt)
        XCTAssertFalse(report.conversationSyncReported)
        XCTAssertNil(report.snapshot)
        XCTAssertTrue(report.snapshotStatusUnavailable)
        XCTAssertFalse(String(describing: report).contains("sentinel"))
        XCTAssertEqual(plan.requests.count, 3)
    }

    func testSuccessfulUploadIsNotPresentedAsACompletedVerification() {
        let capability = WorkspaceBackupCapability(workspaceBackupAvailable: true)
        let snapshot = LocalSnapshotStatus(
            lastAttemptAt: 2_000,
            lastSuccessAt: 2_000,
            lastOutcome: .success
        )
        let report = LocalFirstStatus(capability: capability, snapshot: snapshot)

        XCTAssertNil(report.lastVerifiedSnapshotAt)
        XCTAssertEqual(report.lastSuccessfulSnapshotAt, 2_000)
    }

    func testIncompleteCapabilityDoesNotGuessThatStorageIsLocalOnly() {
        let capability = WorkspaceBackupCapability(accountDrive: AccountDriveAvailability(available: true))
        XCTAssertEqual(capability.storageDestination, .unknown)
    }

    func testLoadedDataSummaryCountsOnlyVisibleFleetPagesAlreadyInMemory() {
        let visible = Bot(
            id: "visible",
            threadId: "visible-thread",
            name: "Visible",
            title: "",
            description: "",
            notifications: true,
            color: "blue",
            unread: false,
            modelSelection: ModelSelection(instanceId: "fixture", model: "fixture"),
            createdAt: 1,
            hidden: false
        )
        let hidden = Bot(
            id: "hidden",
            threadId: "hidden-thread",
            name: "Hidden",
            title: "",
            description: "",
            notifications: true,
            color: "green",
            unread: false,
            modelSelection: ModelSelection(instanceId: "fixture", model: "fixture"),
            createdAt: 1,
            hidden: true
        )
        let room = Room(
            id: "room",
            threadId: "room-thread",
            name: "Room",
            memberIds: ["visible"],
            defaultResponder: GroupResponder(kind: "bot", botId: "visible"),
            bulletin: "",
            unread: false,
            createdAt: 1
        )
        var state = CompanionState()
        state.bots = [visible, hidden]
        state.rooms = [room]
        state.messages = [
            "visible-thread": [message("one", at: 100), message("two", at: 300)],
            "hidden-thread": [message("hidden-message", at: 200)],
            "room-thread": [message("three", at: 250)],
        ]

        let summary = LocalDataSummary(state: state)

        XCTAssertEqual(summary.botCount, 1)
        XCTAssertEqual(summary.roomCount, 1)
        XCTAssertEqual(summary.threadCount, 2)
        XCTAssertEqual(summary.messageCount, 3)
        XCTAssertEqual(summary.lastActivityAt, 300)
    }

    private func message(_ id: String, at: Double) -> Message {
        Message(id: id, role: .user, kind: .text, at: at, text: "fixture")
    }
}
