import XCTest
@testable import CompanionCore

private actor HeldFleetRead {
    private(set) var count = 0
    private var pending: [Int: CheckedContinuation<Fleet, Error>] = [:]
    func read() async throws -> Fleet {
        try await withCheckedThrowingContinuation { continuation in
            pending[count] = continuation; count += 1
        }
    }
    func resolve(_ index: Int, _ fleet: Fleet) { pending.removeValue(forKey: index)?.resume(returning: fleet) }
    func waitForCount(_ expected: Int) async {
        let deadline = Date().addingTimeInterval(2)
        while count < expected && Date() < deadline { await Task.yield() }
        XCTAssertEqual(count, expected)
    }
}

final class SeedSnapshotRefreshTests: XCTestCase {
    @MainActor func testStaleHydrateCannotEraseAcceptedAnswerAndMustFetchAgainBeforeCommittingCursor() async throws {
        var bot = Bot(id: "owner", threadId: "thread", name: "Fixture", title: "", description: "", notifications: false,
                      color: "orange", unread: false, modelSelection: ModelSelection(instanceId: "fixture", model: "offline"), createdAt: 0)
        bot.activeLeafId = "welcome-card"
        bot.messages = [Message(id: "greeting", role: .bot, kind: .text, at: 1, text: "Hey — I'm Original. Nice to meet you."), coordinatorQuestion()]
        let oldFleet = Fleet(bots: [bot], groups: [])
        var state = CompanionState(); state.hydrate(oldFleet)
        var revision: UInt64 = 0
        let reads = HeldFleetRead()
        var committed = false
        let refresh = Task {
            try await SeedSnapshotRefresh.hydrate(read: { try await reads.read() }, revision: { revision }, current: { true }, apply: { fleet in
                state.hydrate(fleet); revision += 1
            }, retryDelayNanoseconds: 0)
            state.resetCursor("new-server:9"); committed = true
        }
        await reads.waitForCount(1)
        XCTAssertEqual(state.mergeSeedAnswer(botId: "owner", threadId: "thread", cardId: "welcome-card", result: coordinatorResult(status: .started)), .accepted)
        revision += 1
        await reads.resolve(0, oldFleet)
        await reads.waitForCount(2)
        XCTAssertFalse(committed)
        XCTAssertEqual(state.messages["thread"]?.first(where: { $0.id == "welcome-card" })?.card?.seedAnswer?.status, .started)
        bot.messages = state.messages["thread"]; bot.activeLeafId = "saved-user"
        await reads.resolve(1, Fleet(bots: [bot], groups: [])); try await refresh.value
        XCTAssertTrue(committed); XCTAssertEqual(state.cursor, "new-server:9")
        XCTAssertEqual(state.messages["thread"]?.filter { $0.id == "saved-user" }.count, 1)
    }

    @MainActor func testRepeatedChangesBoundRetriesAndDoNotClaimRecovery() async {
        var revision: UInt64 = 0; var calls = 0; var applied = false
        do {
            try await SeedSnapshotRefresh.hydrate(read: {
                calls += 1; revision += 1; return Fleet(bots: [], groups: [])
            }, revision: { revision }, current: { true }, apply: { _ in applied = true }, retryDelayNanoseconds: 0)
            XCTFail("A changing snapshot must leave recovery incomplete")
        } catch { XCTAssertTrue(error.localizedDescription.contains("refreshing")) }
        XCTAssertEqual(calls, 3); XCTAssertFalse(applied)
    }

    @MainActor func testOldSessionAndCancelledReadsCannotAdoptSnapshot() async {
        for cancelled in [true, false] {
            let reads = HeldFleetRead(); var current = true; var applied = false
            let refresh = Task {
                try await SeedSnapshotRefresh.hydrate(read: { try await reads.read() }, revision: { 0 }, current: { current }, apply: { _ in applied = true }, retryDelayNanoseconds: 0)
            }
            await reads.waitForCount(1)
            if cancelled { refresh.cancel() } else { current = false }
            await reads.resolve(0, Fleet(bots: [], groups: []))
            do { try await refresh.value; XCTFail("Stale recovery should cancel") } catch { XCTAssertTrue(error is CancellationError) }
            XCTAssertFalse(applied)
        }
    }

    @MainActor func testUnchangedSnapshotAppliesExactlyOnceWithoutExtraRead() async throws {
        var reads = 0; var applied = 0
        try await SeedSnapshotRefresh.hydrate(read: { reads += 1; return Fleet(bots: [], groups: []) }, revision: { 3 }, current: { true }, apply: { _ in applied += 1 }, retryDelayNanoseconds: 0)
        XCTAssertEqual(reads, 1); XCTAssertEqual(applied, 1)
    }
}
