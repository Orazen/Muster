// M0 contract tests: fixture decode compatibility with CompanionCore wire
// types, the local-only send/approval/memory state machines, and the
// harness probe's GET-only boundary. These run with `swift test` — no GUI,
// no network, no signing.

import CompanionCore
import XCTest

@testable import MusterMacCore

@MainActor
final class FixtureDecodingTests: XCTestCase {
    func testFixtureFleetDecodesThroughCompanionCoreTypes() {
        let model = PrototypeModel.fixture()
        XCTAssertEqual(model.fleet.bots.count, 3)
        XCTAssertEqual(model.fleet.groups.count, 1)
        // The working/unread/idle distinction the sidebar renders.
        XCTAssertEqual(model.fleet.bots.filter { $0.busy == true }.count, 1)
        XCTAssertEqual(model.fleet.bots.filter { $0.unread == true }.count, 1)
    }

    func testPendingCardUsesCompanionCoreContract() {
        let fixture = FixtureFleet.standard()
        XCTAssertTrue(fixture.pendingCard.card?.isPending ?? false)
        XCTAssertEqual(fixture.pendingCard.card?.options.count, 3)
        // The why-journal fields ride the same contract as production cards.
        XCTAssertEqual(fixture.pendingCard.card?.why?.source, "previous-run")
    }

    func testPlanAndCalendarFixturesAreConsistent() {
        let fixture = FixtureFleet.standard()
        XCTAssertEqual(fixture.plan.count, 3, "the concept's three priorities")
        XCTAssertGreaterThanOrEqual(fixture.calendar.count, 5)
        XCTAssertTrue(fixture.memories.allSatisfy { $0.origin.contains("Sample") },
                      "sample memories must be visibly labeled")
    }
}

final class LocalMutationTests: XCTestCase {
    @MainActor
    func testSendDraftAppendsLocallyAndClearsDraft() {
        let model = PrototypeModel.fixture()
        model.destination = .conversations
        model.draft = "  A local draft  "
        let send = model.sendDraft()
        XCTAssertNotNil(send)
        XCTAssertEqual(send?.text, "A local draft")
        XCTAssertEqual(send?.sessionSendCount, 1)
        XCTAssertTrue(model.selectedMessages.contains { $0.text == "A local draft" && $0.role == .user })
        XCTAssertEqual(model.draft, "")
    }

    @MainActor
    func testSendRefusesBlankDraft() {
        let model = PrototypeModel.fixture()
        model.draft = "   "
        XCTAssertNil(model.sendDraft())
        XCTAssertEqual(model.sends.count, 0)
    }

    @MainActor
    func testAnsweringCardRetiresItFromPending() {
        let model = PrototypeModel.fixture()
        model.destination = .conversations
        let pending = model.pendingCardMessage
        XCTAssertNotNil(pending)
        model.answerPendingCard(option: "Allow once")
        XCTAssertNil(model.pendingCardMessage, "an answered card is no longer pending")
        // The outcome is recorded on the card, as a real client would fold it.
        let threadId = model.selectedThreadId
        let answered = model.transcripts[threadId ?? ""]?.first { $0.id == pending?.id }
        XCTAssertEqual(answered?.card?.answered, "Allow once")
    }

    @MainActor
    func testDismissingCardAlsoRetiresIt() {
        let model = PrototypeModel.fixture()
        model.destination = .conversations
        XCTAssertNotNil(model.pendingCardMessage)
        model.answerPendingCard(option: nil)
        XCTAssertNil(model.pendingCardMessage)
    }

    @MainActor
    func testMemoryForgetAndReset() {
        let model = PrototypeModel.fixture()
        let count = model.memories.count
        XCTAssertEqual(count, 3)
        model.forgetMemory(id: 0)
        XCTAssertEqual(model.memories.count, 2)
        XCTAssertFalse(model.memories.contains { $0.id == 0 })
        model.resetMemories()
        XCTAssertEqual(model.memories.count, 3)
    }

    @MainActor
    func testPlanReviewEditsStayLocal() {
        let model = PrototypeModel.fixture()
        XCTAssertEqual(model.includedBlockCount, 3)
        model.toggleBlock(id: 1)
        XCTAssertEqual(model.includedBlockCount, 2)
        model.setBlockTime(id: 0, start: "08:15")
        XCTAssertEqual(model.plan[0].start, "08:15")
    }

    @MainActor
    func testDeviceFixtureDrivesWaitingState() {
        let model = PrototypeModel.fixture()
        XCTAssertTrue(model.device.macAwake)
        XCTAssertEqual(model.hostLabel, "On this Mac")
        model.device = DeviceFixture(macAwake: false)
        XCTAssertEqual(model.hostLabel, "Waiting for your Mac")
        XCTAssertEqual(model.hostDetail, "Mac asleep · tasks will wait")
    }

    @MainActor
    func testAppearanceResolvesColorScheme() {
        XCTAssertNil(Appearance.system.colorScheme)
        XCTAssertEqual(Appearance.light.colorScheme, .light)
        XCTAssertEqual(Appearance.dark.colorScheme, .dark)
    }
}

@MainActor
final class HarnessProbeBoundaryTests: XCTestCase {
    func testProbeRefusesEveryNonGetVerb() {
        // The boundary is the point: no caller can mutate through the probe.
        for verb in ["POST", "PUT", "PATCH", "DELETE"] {
            XCTAssertTrue(HarnessProbe.refusesMutation(verb), "\(verb) must be refused")
        }
        XCTAssertFalse(HarnessProbe.refusesMutation("GET"))
    }

    func testFixtureFleetRoundTripsThroughJSONDecoding() throws {
        // Decode the fixture fleet through the real CompanionCore contract
        // by round-tripping it: encode the types the UI consumes, decode
        // them again, and require equality. This is the same Fleet type the
        // live /api/bots parser builds.
        let model = PrototypeModel.fixture()
        let encoder = JSONEncoder()
        let data = try encoder.encode(FixtureFleet.standard().fleet.bots)
        let decoded = try JSONDecoder().decode([Bot].self, from: data)
        XCTAssertEqual(decoded, model.fleet.bots)
    }
}
