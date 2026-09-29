// WatchHandoffOrderingTests — the ordering decision, which is where the revoked
// trust came back.
//
// The 1.20 tests pinned the codec and nothing else, so a delivery that arrived
// out of order was indistinguishable from a fresh one. These cases are the four
// the platform audit named: a delayed OLD pair, a delayed OLD unpair, a
// duplicate, and a restart. Each is a delivery the radio genuinely produces,
// because the phone ships every payload twice — once as latest-wins
// application context and once as a queued user-info transfer — and the queued
// copy can surface long after the newer one.
//
// The rule under test: the phone numbers every pairing event and the watch keeps
// the highest number it has ever seen. Higher wins, equal is a no-op, lower is
// dropped. `sentAt` is present in every payload and deliberately unused.
import XCTest
@testable import CompanionCore

/// In-memory store, so the reducer is exercised without UserDefaults and a
/// "restart" can be simulated exactly: a fresh ordering object over the SAME
/// store is what a relaunch looks like.
private final class MemoryTrustStore: HandoffTrustStore {
    var state: HandoffTrustState
    private(set) var saves = 0

    init(_ state: HandoffTrustState = HandoffTrustState()) {
        self.state = state
    }

    func load() -> HandoffTrustState { state }
    func save(_ value: HandoffTrustState) { state = value; saves += 1 }
}

final class WatchHandoffOrderingTests: XCTestCase {
    private func connection(_ id: String) -> Connection {
        Connection(id: id, name: "Muster Box", host: "192.168.1.10", port: 8810, scheme: .http)
    }

    private func pairing(_ id: String, token: String, generation: UInt64?) -> CompanionHandoff {
        CompanionHandoff(
            connection: connection(id),
            token: token,
            sentAt: Date(timeIntervalSince1970: 1_790_000_000),
            generation: generation
        )
    }

    // MARK: - The regression

    func testDelayedOlderPairingCannotReplaceTheCurrentOne() {
        let store = MemoryTrustStore()
        let ordering = WatchHandoffOrdering(store: store)

        // The phone re-paired: computer B, generation 2. The watch adopts it.
        let current = pairing("conn-b", token: "token-b", generation: 2)
        guard case .adopt = ordering.decidePairing(current) else {
            return XCTFail("a first numbered pairing must be adopted")
        }
        ordering.commitAdoption(current)

        // Now the queued copy of the OLD pairing (generation 1) finally lands.
        // Before the fix this replaced the live one, putting the revoked
        // computer's token back into the keychain.
        let delayed = pairing("conn-a", token: "token-a", generation: 1)
        XCTAssertEqual(ordering.decidePairing(delayed), .stale)
        // And the watch still believes what it believed before.
        XCTAssertEqual(ordering.currentState().connection?.id, "conn-b")
        XCTAssertEqual(ordering.currentState().tokenFingerprint, handoffTokenFingerprint("token-b"))
        // The credential itself must be nowhere in the persisted state: this
        // value lands in UserDefaults, which is plaintext.
        let encoded = String(data: (try? JSONEncoder().encode(ordering.currentState())) ?? Data(), encoding: .utf8) ?? ""
        XCTAssertFalse(encoded.contains("token-b"))
        XCTAssertTrue(encoded.contains("tokenFingerprint"))
    }

    func testDelayedOlderUnpairCannotSignOutALivePairing() {
        let store = MemoryTrustStore()
        let ordering = WatchHandoffOrdering(store: store)

        // Generation 1 was an unpair that has not been delivered yet.
        // Generation 2 is a fresh pairing, delivered first.
        let fresh = pairing("conn-b", token: "token-b", generation: 2)
        guard case .adopt = ordering.decidePairing(fresh) else {
            return XCTFail("a first numbered pairing must be adopted")
        }
        ordering.commitAdoption(fresh)

        // The stale tombstone arrives. Honouring it would drop a live pairing
        // the user can see working — the watch would report itself signed out
        // for no reason, and the next real action would need a re-pair.
        XCTAssertEqual(ordering.decideUnpair(generation: 1), .stale)
        XCTAssertEqual(ordering.currentState().connection?.id, "conn-b")
        XCTAssertTrue(ordering.currentState().isPaired)
    }

    // MARK: - What must still work

    func testNewerPairingWins() {
        let store = MemoryTrustStore()
        let ordering = WatchHandoffOrdering(store: store)
        let first = pairing("conn-a", token: "token-a", generation: 1)
        ordering.commitAdoption(first)

        let second = pairing("conn-b", token: "token-b", generation: 2)
        guard case .adopt = ordering.decidePairing(second) else {
            return XCTFail("a newer pairing must be adopted")
        }
        ordering.commitAdoption(second)
        XCTAssertEqual(ordering.currentState().connection?.id, "conn-b")
    }

    func testRedeliveryOfTheSamePairingIsANoOp() {
        let store = MemoryTrustStore()
        let ordering = WatchHandoffOrdering(store: store)
        let handoff = pairing("conn-a", token: "token-a", generation: 1)
        ordering.commitAdoption(handoff)

        // The application-context and user-info copies of ONE event both land.
        XCTAssertEqual(ordering.decidePairing(handoff), .duplicate)
        let savesBefore = store.saves
        XCTAssertEqual(ordering.decidePairing(handoff), .duplicate)
        // A duplicate must not churn the store either.
        XCTAssertEqual(store.saves, savesBefore)
        XCTAssertEqual(ordering.currentState().connection?.id, "conn-a")
    }

    func testNewerUnpairUnpairs() {
        let store = MemoryTrustStore()
        let ordering = WatchHandoffOrdering(store: store)
        let handoff = pairing("conn-a", token: "token-a", generation: 1)
        ordering.commitAdoption(handoff)

        XCTAssertEqual(ordering.decideUnpair(generation: 2), .unpair(generation: 2))
        XCTAssertNil(ordering.currentState().connection)
        XCTAssertFalse(ordering.currentState().isPaired)
        // The floor survives the unpair, which is what makes a LATER stale
        // pairing droppable rather than adopted into a signed-out watch.
        XCTAssertEqual(ordering.currentState().generation, 2)
    }

    func testUnpairThenStalePairStaysUnpaired() {
        let store = MemoryTrustStore()
        let ordering = WatchHandoffOrdering(store: store)
        ordering.commitAdoption(pairing("conn-a", token: "token-a", generation: 1))
        ordering.decideUnpair(generation: 5)

        // A pairing queued long before that unpair finally arrives.
        XCTAssertEqual(ordering.decidePairing(pairing("conn-a", token: "token-a", generation: 1)), .stale)
        XCTAssertNil(ordering.currentState().connection)
    }

    // MARK: - Restart

    func testGenerationSurvivesRestartSoQueuedTransfersCannotReviveTrust() {
        let store = MemoryTrustStore()
        let first = WatchHandoffOrdering(store: store)
        let revoked = pairing("conn-a", token: "token-a", generation: 1)
        first.commitAdoption(revoked)
        first.decideUnpair(generation: 2)
        XCTAssertNil(first.currentState().connection)

        // The wrist app is relaunched. The queued user-info transfer for the
        // REVOKED pairing is still sitting in WatchConnectivity, and it delivers
        // after activation. A store that forgot its generation would adopt it.
        let relaunched = WatchHandoffOrdering(store: store)
        XCTAssertEqual(relaunched.decidePairing(revoked), .stale)
        XCTAssertNil(relaunched.currentState().connection)
    }

    func testFreshInstallAcceptsTheFirstNumberedPairing() {
        let ordering = WatchHandoffOrdering(store: MemoryTrustStore())
        let handoff = pairing("conn-a", token: "token-a", generation: 1)
        guard case .adopt = ordering.decidePairing(handoff) else {
            return XCTFail("a first pairing on a fresh watch must be adopted")
        }
    }

    // MARK: - A phone that predates generations

    func testUnnumberedPairingIsHonouredOnAFreshWatchAndDroppedAfterwards() {
        let store = MemoryTrustStore()
        let ordering = WatchHandoffOrdering(store: store)
        let legacy = CompanionHandoff(
            connection: connection("conn-a"),
            token: "token-a",
            sentAt: Date(timeIntervalSince1970: 1_790_000_000)
        )
        XCTAssertNil(legacy.generation)
        guard case .adopt = ordering.decidePairing(legacy) else {
            return XCTFail("a 1.20 pairing on an empty watch must still work")
        }
        ordering.commitAdoption(legacy)

        // Once the watch has seen a numbered event, an unnumbered delivery
        // cannot be shown to be newer — so it is dropped rather than trusted.
        ordering.commitAdoption(pairing("conn-b", token: "token-b", generation: 1))
        XCTAssertEqual(ordering.decidePairing(legacy), .stale)
        XCTAssertEqual(ordering.currentState().connection?.id, "conn-b")
    }

    func testUnnumberedUnpairIsStillHonoured() {
        let store = MemoryTrustStore()
        let ordering = WatchHandoffOrdering(store: store)
        ordering.commitAdoption(pairing("conn-a", token: "token-a", generation: 1))
        // An old phone's bare marker. Being wrong in the unpair direction leaves
        // a watch signed out of a pairing the phone has genuinely dropped;
        // refusing it would leave a watch paired to a phone that moved on.
        guard case .unpair = ordering.decideUnpair(generation: nil) else {
            return XCTFail("a 1.20 unpair marker must still unpair")
        }
        XCTAssertNil(ordering.currentState().connection)
    }

    func testEqualGenerationCannotChangeConnectionTokenOrEndpoint() {
        let store = MemoryTrustStore()
        let ordering = WatchHandoffOrdering(store: store)
        let current = pairing("conn-a", token: "token-a", generation: 3)
        ordering.commitAdoption(current)
        var movedEndpoint = current
        movedEndpoint.connection.host = "192.168.1.20"
        let conflicting = [
            pairing("conn-b", token: "token-a", generation: 3),
            pairing("conn-a", token: "token-b", generation: 3),
            movedEndpoint,
        ]
        let before = store.state
        let saves = store.saves
        for candidate in conflicting {
            XCTAssertEqual(ordering.decidePairing(candidate), .stale)
        }
        XCTAssertEqual(store.state, before)
        XCTAssertEqual(store.saves, saves)
        XCTAssertEqual(ordering.decidePairing(current), .duplicate)
    }

    func testLegacyUnpairRejectsSameGenerationReplayAndAllowsFreshPairing() throws {
        let store = MemoryTrustStore()
        let ordering = WatchHandoffOrdering(store: store)
        let old = pairing("conn-a", token: "token-a", generation: 3)
        ordering.commitAdoption(old)
        XCTAssertEqual(ordering.decideUnpair(generation: nil), .unpair(generation: 3))
        XCTAssertEqual(ordering.decidePairing(old), .stale)

        // Round-trip the actual persisted state, then build a new reducer.
        let restored = MemoryTrustStore(try JSONDecoder().decode(
            HandoffTrustState.self, from: JSONEncoder().encode(store.state)
        ))
        let restarted = WatchHandoffOrdering(store: restored)
        XCTAssertEqual(restarted.decidePairing(old), .stale)
        let fresh = pairing("conn-b", token: "token-b", generation: 4)
        XCTAssertEqual(restarted.decidePairing(fresh), .adopt(fresh))
        restarted.commitAdoption(fresh)
        XCTAssertEqual(restarted.decidePairing(fresh), .duplicate)
        XCTAssertEqual(restarted.currentState().pairingRevoked, false)
    }

    func testNumberedUnpairRejectsConflictingPairAtItsOwnGeneration() {
        let ordering = WatchHandoffOrdering(store: MemoryTrustStore())
        _ = ordering.decideUnpair(generation: 4)
        XCTAssertEqual(ordering.decidePairing(pairing("conn-a", token: "token-a", generation: 4)), .stale)
    }

    func testLegacyZeroFloorUnpairSurvivesSerializationAndBlocksOldPair() throws {
        let store = MemoryTrustStore()
        let ordering = WatchHandoffOrdering(store: store)
        let legacy = pairing("conn-a", token: "token-a", generation: nil)
        XCTAssertEqual(ordering.decidePairing(legacy), .adopt(legacy))
        ordering.commitAdoption(legacy)
        XCTAssertEqual(ordering.decidePairing(legacy), .duplicate)
        _ = ordering.decideUnpair(generation: nil)
        let reloaded = MemoryTrustStore(try JSONDecoder().decode(
            HandoffTrustState.self, from: JSONEncoder().encode(store.state)
        ))
        let restarted = WatchHandoffOrdering(store: reloaded)
        XCTAssertEqual(restarted.decidePairing(legacy), .stale)
        XCTAssertEqual(restarted.decidePairing(pairing("conn-a", token: "token-a", generation: 0)), .stale)
        let fresh = pairing("conn-a", token: "token-new", generation: 1)
        XCTAssertEqual(restarted.decidePairing(fresh), .adopt(fresh))
    }

    func testLegacyStateWithoutRevocationFieldStillDecodes() throws {
        let data = Data(#"{"generation":0,"counter":0}"#.utf8)
        let decoded = try JSONDecoder().decode(HandoffTrustState.self, from: data)
        XCTAssertNil(decoded.pairingRevoked)
        let ordering = WatchHandoffOrdering(store: MemoryTrustStore(decoded))
        let legacy = pairing("conn-a", token: "token-a", generation: nil)
        XCTAssertEqual(ordering.decidePairing(legacy), .adopt(legacy))
    }

    func testLegacyRevocationSurvivesReopeningItsOwnDefaultsStore() throws {
        let suite = "com.muster.test.handoff.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let original = WatchHandoffOrdering(store: UserDefaultsHandoffTrustStore(defaults: defaults))
        let old = pairing("conn-a", token: "token-a", generation: nil)
        original.commitAdoption(old)
        _ = original.decideUnpair(generation: nil)
        XCTAssertTrue(defaults.synchronize())

        let reopenedDefaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let reopened = WatchHandoffOrdering(store: UserDefaultsHandoffTrustStore(defaults: reopenedDefaults))
        XCTAssertEqual(reopened.currentState().pairingRevoked, true)
        XCTAssertEqual(reopened.decidePairing(old), .stale)
        let fresh = pairing("conn-a", token: "token-new", generation: 1)
        XCTAssertEqual(reopened.decidePairing(fresh), .adopt(fresh))
    }

    func testLegacyUnnumberedConflictCannotReplaceEstablishedPairing() {
        let ordering = WatchHandoffOrdering(store: MemoryTrustStore())
        ordering.commitAdoption(pairing("conn-a", token: "token-a", generation: nil))
        XCTAssertEqual(ordering.decidePairing(pairing("conn-b", token: "token-b", generation: nil)), .stale)
    }

    func testNewerExactDuplicateAdvancesReplayFloor() {
        let ordering = WatchHandoffOrdering(store: MemoryTrustStore())
        ordering.commitAdoption(pairing("conn-a", token: "token-a", generation: 1))
        XCTAssertEqual(ordering.decidePairing(pairing("conn-a", token: "token-a", generation: 7)), .duplicate)
        XCTAssertEqual(ordering.currentState().generation, 7)
        XCTAssertEqual(ordering.decidePairing(pairing("conn-b", token: "token-b", generation: 6)), .stale)
    }

    // MARK: - The phone's counter

    func testGenerationCounterNeverRepeatsAndNeverGoesBackwards() {
        var state = HandoffTrustState()
        var seen: [UInt64] = []
        for _ in 0..<5 {
            let (generation, updated) = WatchHandoffOrdering.nextGeneration(state)
            seen.append(generation)
            state = updated
        }
        XCTAssertEqual(seen, [1, 2, 3, 4, 5])
        XCTAssertEqual(state.counter, 5)
        XCTAssertEqual(state.generation, 5)
    }

    func testCounterResumesAboveAGenerationItLearnedFromTheWire() {
        // A watch that adopted generation 9 (a restore, or a phone that had
        // been counting longer) must not hand out 1 and collide with it.
        let store = MemoryTrustStore(HandoffTrustState(generation: 9, counter: 0))
        let (generation, updated) = WatchHandoffOrdering.nextGeneration(store.load())
        XCTAssertEqual(generation, 10)
        XCTAssertEqual(updated.generation, 10)
    }
}
