import XCTest
@testable import CompanionCore

/// The share sheet is an untrusted door. These cases pin what is accepted,
/// what is refused with which reason, and the two properties that matter most
/// when a message arrives from outside the app: it is never sent on its own,
/// and it can never destroy a draft the owner was already writing.
@MainActor
final class ShareIntakeTests: XCTestCase {
    private let at = Date(timeIntervalSince1970: 1_700_000_000)

    /// Records what the intake published, because the roster view is driven
    /// entirely by that callback: a state change that does not reach it is a
    /// share the owner cannot see, and nothing else would notice.
    @MainActor
    private final class Harness {
        private var roster = CompanionState()
        private let capacity: Int
        private let maximumBytes: Int
        let session = UUID()
        var published: [[SharedText]] = []
        var publishedNotices: [String?] = []

        /// Lazy because the callbacks name `self`; the same shape
        /// `ComposerHarness` uses for its coordinator.
        lazy var intake = ShareIntake(readState: { [unowned self] in self.roster },
                                      changed: { [unowned self] in self.published.append($0) },
                                      noticeChanged: { [unowned self] in self.publishedNotices.append($0) },
                                      capacity: capacity, maximumBytes: maximumBytes)

        var bot: ComposerContext {
            ComposerContext(sessionId: session, target: .init(kind: .bot, ownerId: "owner", threadId: "displayed-thread"))
        }
        var room: ComposerContext {
            ComposerContext(sessionId: session, target: .init(kind: .room, ownerId: "room", threadId: "room-thread"))
        }
        /// A target the roster does not contain, for the stale-context case.
        var absent: ComposerContext {
            ComposerContext(sessionId: session, target: .init(kind: .bot, ownerId: "owner", threadId: "not-a-live-thread"))
        }

        init(capacity: Int = ShareLimits.capacity, maximumBytes: Int = ShareLimits.maximumBytes, state: CompanionState? = nil) {
            self.capacity = capacity
            self.maximumBytes = maximumBytes
            if let state {
                self.roster = state
            } else {
                self.roster.bots = [Bot(id: "owner", threadId: "displayed-thread", name: "Orbit", title: "", description: "",
                    notifications: false, color: "orange", unread: false,
                    modelSelection: ModelSelection(instanceId: "offline", model: "fixture"), createdAt: 1)]
                self.roster.rooms = [Room(id: "room", threadId: "room-thread", name: "Room", memberIds: [],
                    defaultResponder: GroupResponder(kind: "none"), bulletin: "", unread: false, createdAt: 1)]
            }
            intake.bind(sessionId: session)
        }
    }

    private func harness(capacity: Int = ShareLimits.capacity, maximumBytes: Int = ShareLimits.maximumBytes,
                         state: CompanionState? = nil) -> Harness {
        Harness(capacity: capacity, maximumBytes: maximumBytes, state: state)
    }

    private func payload(_ declaredText: Bool = true, _ declaredLink: Bool = false, _ candidates: [Data]) -> SharePayload {
        SharePayload(declaredText: declaredText, declaredLink: declaredLink, candidates: candidates)
    }

    /// A refusal here is a test failure, never a skip: a share that used to
    /// be accepted and now is not is a regression, and skipping it would
    /// hide exactly the change these cases exist to catch.
    @discardableResult
    private func stage(_ h: Harness, _ value: String, file: StaticString = #filePath, line: UInt = #line) -> SharedText {
        let result = h.intake.receive(payload(true, false, [Data(value.utf8)]), receivedAt: at)
        guard case .success(let item) = result else {
            XCTFail("expected acceptance, got \(result)", file: file, line: line)
            return SharedText(text: "", receivedAt: at)
        }
        return item
    }

    // MARK: the boundary

    func testUndeclaredAttachmentIsUnsupported() {
        let h = harness()
        // A photo offered with no textual type at all. Refusing is the point:
        // there is no importer, and a guess would be a wrong guess.
        let result = h.intake.receive(payload(false, false, [Data("notes".utf8)]), receivedAt: at)
        guard case .failure(let rejection) = result else { return XCTFail("expected refusal") }
        XCTAssertEqual(rejection, .unsupported)
        XCTAssertTrue(h.intake.items.isEmpty)
    }

    func testDeclaredTypeWithNoBytesIsEmptyNotUnsupported() {
        let h = harness()
        let result = h.intake.receive(payload(true, false, []), receivedAt: at)
        guard case .failure(let rejection) = result else { return XCTFail("expected refusal") }
        XCTAssertEqual(rejection, .empty)
    }

    func testWhitespaceOnlyShareIsEmpty() {
        let h = harness()
        // The server trims on the wire, so a share of "\n\t " is a message
        // that would arrive as nothing at all. Refuse it at the door.
        let result = h.intake.receive(payload(true, false, [Data("  \n\t\u{00A0} ".utf8)]), receivedAt: at)
        guard case .failure(let rejection) = result else { return XCTFail("expected refusal") }
        XCTAssertEqual(rejection, .empty)
        XCTAssertTrue(h.intake.items.isEmpty)
    }

    func testInvalidUTF8IsRefusedRatherThanReplaced() {
        let h = harness()
        // A lone lead byte with a bad continuation. `String(decoding:as:)`
        // would render U+FFFD and send that; the promise is that staged text
        // is exactly what was shared, or nothing.
        var bytes = Data("hi".utf8); bytes.append(contentsOf: [0xC3, 0x28])
        let result = h.intake.receive(payload(true, false, [bytes]), receivedAt: at)
        guard case .failure(let rejection) = result else { return XCTFail("expected refusal") }
        XCTAssertEqual(rejection, .empty)
        XCTAssertTrue(h.intake.items.isEmpty)
    }

    func testOversizeShareIsRefusedNotTruncated() {
        let h = harness(maximumBytes: 16)
        let result = h.intake.receive(payload(true, false, [Data(String(repeating: "a", count: 40).utf8)]), receivedAt: at)
        guard case .failure(let rejection) = result else { return XCTFail("expected refusal") }
        XCTAssertEqual(rejection, .tooLarge(bytes: 40))
        XCTAssertTrue(h.intake.items.isEmpty)
    }

    func testByteCapCountsUTF8NotCharacters() {
        let h = harness(maximumBytes: 8)
        // Six characters, 18 bytes. A character count would have let this
        // through and then failed the composer's 1 MB guard much later.
        let value = "’‘“”…—"
        XCTAssertEqual(value.utf8.count, 18)
        let result = h.intake.receive(payload(true, false, [Data(value.utf8)]), receivedAt: at)
        guard case .failure(let rejection) = result else { return XCTFail("expected refusal") }
        XCTAssertEqual(rejection, .tooLarge(bytes: value.utf8.count))
    }

    func testCandidatesAreTriedInOrderAndTheFirstUsableOneWins() {
        let h = harness()
        // Page, then the quoted selection, then a caption. One share is one
        // message; concatenating would invent text nobody shared.
        let result = h.intake.receive(
            payload(true, true, [Data("   ".utf8), Data("the real note".utf8), Data("caption".utf8)]), receivedAt: at)
        guard case .success(let item) = result else { return XCTFail("expected acceptance") }
        XCTAssertEqual(item.text, "the real note")
        XCTAssertEqual(h.intake.items.count, 1)
    }

    func testAnOversizeFirstCandidateDoesNotShadowAGoodSecondOne() {
        let h = harness(maximumBytes: 16)
        let result = h.intake.receive(
            payload(true, false, [Data(String(repeating: "a", count: 40).utf8), Data("short".utf8)]), receivedAt: at)
        guard case .success(let item) = result else { return XCTFail("expected acceptance") }
        XCTAssertEqual(item.text, "short")
    }

    func testLinkOnlyShareIsAccepted() {
        let h = harness()
        let result = h.intake.receive(payload(false, true, [Data("https://example.test/post".utf8)]), receivedAt: at)
        guard case .success(let item) = result else { return XCTFail("expected acceptance") }
        XCTAssertEqual(item.text, "https://example.test/post")
    }

    func testStagedTextIsVerbatimIncludingSurroundingWhitespace() {
        let h = harness()
        let raw = "  line one\n\nline two  "
        let result = h.intake.receive(payload(true, false, [Data(raw.utf8)]), receivedAt: at)
        guard case .success(let item) = result else { return XCTFail("expected acceptance") }
        // Trimming here would change what was shared. The composer normalizes
        // on the wire, exactly as it does for a typed draft.
        XCTAssertTrue(item.text.utf16.elementsEqual(raw.utf16))
    }

    // MARK: pairing fences

    func testUnpairedIntakeRefusesRatherThanQueuing() {
        let intake = ShareIntake(readState: { CompanionState() })
        XCTAssertFalse(intake.isPaired)
        let result = intake.receive(payload(true, false, [Data("note".utf8)]), receivedAt: at)
        guard case .failure(let rejection) = result else { return XCTFail("expected refusal") }
        XCTAssertEqual(rejection, .notPaired)
        XCTAssertTrue(intake.items.isEmpty)
    }

    func testRebindingToAnotherComputerDropsStagedShares() {
        let h = harness()
        let item = stage(h, "secret note")
        // Pairing to a different computer is a different account boundary.
        // A share staged under the first must not surface as a draft in a
        // conversation on the second.
        h.intake.bind(sessionId: UUID())
        XCTAssertTrue(h.intake.items.isEmpty)
        XCTAssertNil(h.intake.route(item.id, for: h.bot, existingDraft: ""))
    }

    func testUnbindingDropsStagedShares() {
        let h = harness()
        _ = stage(h, "note")
        h.intake.bind(sessionId: nil)
        XCTAssertTrue(h.intake.items.isEmpty)
        XCTAssertFalse(h.intake.isPaired)
    }

    func testRebindingTheSameSessionKeepsStagedShares() {
        let h = harness()
        _ = stage(h, "note")
        // Session.connect() rebinds on every reconnect. Clearing there would
        // throw away a share that arrived seconds earlier.
        h.intake.bind(sessionId: h.session)
        XCTAssertEqual(h.intake.items.count, 1)
    }

    func testRouteRefusesAStaleContextAndKeepsTheItem() {
        let h = harness()
        let item = stage(h, "note")
        // A share can land before the roster has finished loading. Swallowing
        // the text then would be the worst outcome, so refuse and keep it.
        XCTAssertNil(h.intake.route(item.id, for: h.absent, existingDraft: ""))
        XCTAssertEqual(h.intake.items.count, 1)
        // The real conversation still gets it.
        XCTAssertNotNil(h.intake.route(item.id, for: h.bot, existingDraft: ""))
    }

    func testRouteRefusesAContextFromAnotherSession() {
        let h = harness()
        let item = stage(h, "note")
        let foreign = ComposerContext(sessionId: UUID(),
                                      target: .init(kind: .bot, ownerId: "owner", threadId: "displayed-thread"))
        XCTAssertNil(h.intake.route(item.id, for: foreign, existingDraft: ""))
        XCTAssertEqual(h.intake.items.count, 1)
    }

    func testHiddenBotIsNotARouteableTarget() {
        var state = CompanionState()
        state.bots = [Bot(id: "owner", threadId: "displayed-thread", name: "Orbit", title: "", description: "",
            notifications: false, color: "orange", unread: false,
            modelSelection: ModelSelection(instanceId: "offline", model: "fixture"), createdAt: 1, hidden: true)]
        let h = harness(state: state)
        let item = stage(h, "note")
        // Hidden conversations are how the roster stops showing a bot. A
        // share must not become a draft in one the owner cannot see.
        XCTAssertNil(h.intake.route(item.id, for: h.bot, existingDraft: ""))
        XCTAssertEqual(h.intake.items.count, 1)
    }

    // MARK: the two properties that matter

    func testRoutingOnlyPrefillsAndNeverSends() {
        let h = harness()
        let item = stage(h, "ship it")
        guard case .prefilled(let staged, let joined) = h.intake.route(item.id, for: h.bot, existingDraft: "") else {
            return XCTFail("expected a prefill")
        }
        XCTAssertEqual(staged.id, item.id)
        XCTAssertEqual(joined, "ship it")
        // Routing consumed the share and posted nothing. The text now only
        // exists as a composer draft until its owner presses Send.
        XCTAssertTrue(h.intake.items.isEmpty)
    }

    func testAnExistingDraftSurvivesTheShare() {
        let h = harness()
        let item = stage(h, "from Safari")
        let draft = "half-written answer"
        guard case .appended(let staged, let joined) = h.intake.route(item.id, for: h.bot, existingDraft: draft) else {
            return XCTFail("expected an append")
        }
        XCTAssertEqual(staged.text, "from Safari")
        XCTAssertEqual(joined, draft + ShareLimits.separator + "from Safari")
        // The owner's own words come first and are not rewritten.
        XCTAssertTrue(joined.hasPrefix(draft))
    }

    func testAWhitespaceOnlyDraftIsNotTreatedAsADraft() {
        let h = harness()
        let item = stage(h, "from Safari")
        // Prefilling over blank space is not destroying anything.
        guard case .prefilled(_, let joined) = h.intake.route(item.id, for: h.bot, existingDraft: "   \n ") else {
            return XCTFail("expected a prefill")
        }
        XCTAssertEqual(joined, "from Safari")
    }

    func testARealDraftIsNeverOverwrittenEvenWhenTheTextMatches() {
        let h = harness()
        let item = stage(h, "same")
        guard case .appended(_, let joined) = h.intake.route(item.id, for: h.bot, existingDraft: "same") else {
            return XCTFail("expected an append")
        }
        XCTAssertEqual(joined, "same" + ShareLimits.separator + "same")
    }

    func testRoomTargetsAreRouteable() {
        let h = harness()
        let item = stage(h, "for the room")
        XCTAssertEqual(h.intake.route(item.id, for: h.room, existingDraft: "")?.joined, "for the room")
    }

    // MARK: queue behaviour

    func testCapacityRefusesTheNewShareNotTheOldest() {
        let h = harness(capacity: 2)
        let first = stage(h, "one")
        _ = stage(h, "two")
        let overflow = h.intake.receive(payload(true, false, [Data("three".utf8)]), receivedAt: at)
        guard case .failure(let rejection) = overflow else { return XCTFail("expected refusal") }
        XCTAssertEqual(rejection, .capacityFull)
        // The oldest staged share is the one the owner may not have seen.
        XCTAssertEqual(h.intake.items.map(\.text), ["one", "two"])
        XCTAssertEqual(h.intake.items.first?.id, first.id)
    }

    func testDiscardingFreesCapacity() {
        let h = harness(capacity: 1)
        let first = stage(h, "one")
        h.intake.discard(first.id)
        XCTAssertTrue(h.intake.items.isEmpty)
        _ = stage(h, "two")
        XCTAssertEqual(h.intake.items.map(\.text), ["two"])
    }

    func testARoutedItemCannotBeRoutedTwice() {
        let h = harness()
        let item = stage(h, "note")
        XCTAssertNotNil(h.intake.route(item.id, for: h.bot, existingDraft: ""))
        // Routing consumed the share, so a second attempt finds nothing. The
        // owner pressed Send at most once.
        XCTAssertNil(h.intake.route(item.id, for: h.bot, existingDraft: ""))
        XCTAssertTrue(h.intake.items.isEmpty)
    }

    func testRereadingTheSameStagedBundleDoesNotPasteTwice() {
        let h = harness()
        let bundle = UUID()
        // The extension leaves its staged bundle on disk, so the app reads it
        // again on every foreground. The words are staged once.
        guard case .success(let first) = h.intake.receive(payload(true, false, [Data("from Safari".utf8)]),
                                                           receivedAt: at, id: bundle) else {
            return XCTFail("expected acceptance")
        }
        let reread = h.intake.receive(payload(true, false, [Data("from Safari".utf8)]), receivedAt: at, id: bundle)
        guard case .failure(let rejection) = reread else { return XCTFail("expected refusal") }
        XCTAssertEqual(rejection, .alreadyStaged)
        XCTAssertEqual(h.intake.items.count, 1)
        XCTAssertEqual(h.intake.items.first?.id, first.id)
    }

    func testAStagedBundleReadAgainAfterSendingIsStillRefused() {
        let h = harness()
        let bundle = UUID()
        guard case .success(let item) = h.intake.receive(payload(true, false, [Data("once".utf8)]),
                                                         receivedAt: at, id: bundle) else {
            return XCTFail("expected acceptance")
        }
        XCTAssertNotNil(h.intake.route(item.id, for: h.bot, existingDraft: ""))
        // Consumed ids are remembered, not just dequeued. The bundle is still
        // on disk, and the next foreground must not restage it.
        let reread = h.intake.receive(payload(true, false, [Data("once".utf8)]), receivedAt: at, id: bundle)
        guard case .failure(let rejection) = reread else { return XCTFail("expected refusal") }
        XCTAssertEqual(rejection, .alreadyStaged)
        XCTAssertTrue(h.intake.items.isEmpty)
    }

    func testADiscardedBundleIsNotRestagedEither() {
        let h = harness()
        let bundle = UUID()
        guard case .success(let item) = h.intake.receive(payload(true, false, [Data("note".utf8)]),
                                                         receivedAt: at, id: bundle) else {
            return XCTFail("expected acceptance")
        }
        h.intake.discard(item.id)
        let reread = h.intake.receive(payload(true, false, [Data("note".utf8)]), receivedAt: at, id: bundle)
        guard case .failure(let rejection) = reread else { return XCTFail("expected refusal") }
        XCTAssertEqual(rejection, .alreadyStaged)
    }

    func testARepairingAllowsTheSameBundleToBeStagedAgain() {
        let h = harness()
        let bundle = UUID()
        _ = h.intake.receive(payload(true, false, [Data("note".utf8)]), receivedAt: at, id: bundle)
        h.intake.discard(bundle)
        // A re-pair is a fresh account boundary with a fresh queue, so the
        // stale bundle on disk is not treated as already-seen.
        h.intake.bind(sessionId: UUID())
        guard case .success = h.intake.receive(payload(true, false, [Data("note".utf8)]), receivedAt: at, id: bundle) else {
            return XCTFail("expected acceptance")
        }
    }

    func testADiscardedItemCannotBeRouted() {
        let h = harness()
        let item = stage(h, "note")
        h.intake.discard(item.id)
        XCTAssertNil(h.intake.route(item.id, for: h.bot, existingDraft: ""))
    }

    func testAnUnknownIdRoutesToNothing() {
        let h = harness()
        _ = stage(h, "note")
        XCTAssertNil(h.intake.route(UUID(), for: h.bot, existingDraft: ""))
        XCTAssertEqual(h.intake.items.count, 1)
    }

    func testIdenticalSharesInARowAreBothKept() {
        let h = harness()
        // Someone may deliberately share the same text twice. The
        // anti-replay fence is a consumed id, not a content hash.
        let a = stage(h, "same")
        let b = stage(h, "same")
        XCTAssertNotEqual(a.id, b.id)
        XCTAssertEqual(h.intake.items.count, 2)
    }

    func testDegenerateLimitsStillAcceptAOneByteShare() {
        let h = harness(capacity: 0, maximumBytes: 0)
        _ = stage(h, "x")
        XCTAssertEqual(h.intake.items.count, 1)
    }

    // MARK: saying why

    func testARefusalIsSurfacedRatherThanSwallowed() {
        let h = harness(maximumBytes: 4)
        // A share that disappears with no explanation is what people report as
        // "sharing is broken". The reason has to reach the owner.
        guard case .failure(let rejection) = h.intake.receive(payload(true, false, [Data("far too long".utf8)]),
                                                                receivedAt: at) else {
            return XCTFail("expected refusal")
        }
        h.intake.report(rejection)
        XCTAssertEqual(h.intake.notice, rejection.reason)
    }

    func testASilentRejectionClearsRatherThanSetsANotice() {
        let h = harness()
        for rejection in [ShareIntake.Rejection.alreadyStaged, ShareIntake.Rejection.notPaired] {
            h.intake.report(rejection)
            XCTAssertNil(h.intake.notice, "\(rejection) should be silent")
        }
        h.intake.clearNotice()
        XCTAssertNil(h.intake.notice)
    }

    func testARePairClearsAStaleNotice() {
        let h = harness()
        h.intake.report(.unsupported)
        XCTAssertNotNil(h.intake.notice)
        h.intake.bind(sessionId: UUID())
        XCTAssertNil(h.intake.notice)
    }

    func testEveryRefusalHasADistinctReason() {
        let reasons = [ShareIntake.Rejection.unsupported, .empty, .tooLarge(bytes: 9), .capacityFull,
                       .alreadyStaged, .notPaired, .targetUnavailable].map(\.reason)
        XCTAssertEqual(Set(reasons).count, reasons.count)
        for reason in reasons { XCTAssertFalse(reason.isEmpty) }
    }

    // MARK: the roster view is driven by the callback

    func testEveryStateChangeReachesTheView() {
        let h = harness()
        let item = stage(h, "note")
        XCTAssertEqual(h.published.last?.map(\.text), ["note"])
        XCTAssertNotNil(h.intake.route(item.id, for: h.bot, existingDraft: ""))
        XCTAssertEqual(h.published.last, [])
        h.intake.report(.unsupported)
        XCTAssertEqual(h.publishedNotices.last, ShareIntake.Rejection.unsupported.reason)
        h.intake.clearNotice()
        XCTAssertNil(h.publishedNotices.last ?? nil)
    }

    func testARefusedSharePublishesNoNewRow() {
        let h = harness(maximumBytes: 4)
        let before = h.published.count
        _ = h.intake.receive(payload(true, false, [Data("far too long".utf8)]), receivedAt: at)
        // A refusal adds nothing to the queue, so the view must not be handed
        // a row it cannot act on.
        XCTAssertEqual(h.published.count, before)
        XCTAssertTrue(h.intake.items.isEmpty)
    }

    func testAStaleRouteAttemptDoesNotDisturbThePublishedList() {
        let h = harness()
        let item = stage(h, "note")
        let before = h.published.count
        XCTAssertNil(h.intake.route(item.id, for: h.absent, existingDraft: ""))
        XCTAssertEqual(h.published.count, before)
        XCTAssertEqual(h.published.last?.map(\.text), ["note"])
    }
}
