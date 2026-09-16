import XCTest
@testable import CompanionCore

/// The flower's expression table and its motion. These guard the contract the
/// web asserts in `flower.test.ts` — every pose must read as itself, not as
/// "idle with a tint" — plus the new time functions, which are the only reason
/// the watch can animate without a screen-driven animation system.
final class FlowerMotionTests: XCTestCase {

    // MARK: - Pose table

    func testPoseTableHasExactlyTheWebsPoses() {
        let expected: Set<String> = [
            "idle", "happy", "sad", "mad", "surprised", "wink", "sleepy", "smug",
            "unsure", "scared", "love", "shy", "sick", "thinking", "focused",
        ]
        XCTAssertEqual(Set(FLOWER_POSES.keys), expected)
    }

    func testIdleIsTheIdentityPose() {
        XCTAssertEqual(FLOWER_POSES["idle"]?.channels, FlowerPose.defaults)
    }

    /// Ported from the web's `flower.test.ts`: a pose that moves fewer than
    /// three channels is indistinguishable from idle at roster size.
    func testEveryPoseExceptIdleMovesAtLeastThreeChannels() {
        for (name, pose) in FLOWER_POSES where name != "idle" {
            let moved = zip(pose.channels, FlowerPose.defaults).filter { $0 != $1 }.count
            XCTAssertGreaterThanOrEqual(moved, 3, "pose \"\(name)\" moves only \(moved) channels")
        }
    }

    func testPoseNamesResolveExactly() {
        XCTAssertTrue(isFlowerPoseName("focused"))
        XCTAssertFalse(isFlowerPoseName("Focus"))
        XCTAssertEqual(flowerPoseFor("happy"), FLOWER_POSES["happy"])
        XCTAssertEqual(flowerPoseFor("HAPPY"), FLOWER_POSES["happy"])
    }

    /// The keyword chain, exercised once per group so a reordered chain that
    /// steals another group's word fails here rather than on a watch.
    func testKeywordChainsLandOnTheWebsPoses() {
        XCTAssertEqual(flowerPoseFor("celebrating"), FLOWER_POSES["happy"])
        XCTAssertEqual(flowerPoseFor("sleeping"), FLOWER_POSES["sleepy"])
        XCTAssertEqual(flowerPoseFor("planning"), FLOWER_POSES["thinking"])
        XCTAssertEqual(flowerPoseFor("working"), FLOWER_POSES["focused"])
        XCTAssertEqual(flowerPoseFor("failed"), FLOWER_POSES["mad"])
        XCTAssertEqual(flowerPoseFor("notifying"), FLOWER_POSES["surprised"])
        XCTAssertEqual(flowerPoseFor("reviewing"), FLOWER_POSES["smug"])
        XCTAssertEqual(flowerPoseFor("dragging"), FLOWER_POSES["scared"])
        XCTAssertEqual(flowerPoseFor("hungover"), FLOWER_POSES["sick"])
    }

    func testUnknownStateRestsAtIdle() {
        XCTAssertEqual(flowerPoseFor(nil), FLOWER_POSES["idle"])
        XCTAssertEqual(flowerPoseFor(""), FLOWER_POSES["idle"])
        XCTAssertEqual(flowerPoseFor("zzz-nothing-matches-this"), FLOWER_POSES["idle"])
    }

    // MARK: - Blink

    func testBlinkIsOpenOutsideItsWindow() {
        XCTAssertEqual(FlowerMotion.blinkScale(seed: 0, at: 0), 1)
        XCTAssertEqual(FlowerMotion.blinkScale(seed: 0, at: 1), 1)
        XCTAssertEqual(FlowerMotion.blinkScale(seed: 0, at: 4), 1)
    }

    func testBlinkClosesAtTheCentreOfItsWindow() {
        let peak = FlowerMotion.blinkCentre * FlowerMotion.blinkPeriod
        XCTAssertEqual(
            FlowerMotion.blinkScale(seed: 0, at: peak),
            FlowerMotion.blinkClosedScale,
            accuracy: 1e-6
        )
    }

    func testBlinkStaysWithinItsBoundsOverManyCycles() {
        for step in 0..<5700 {
            let scale = FlowerMotion.blinkScale(seed: 0.37, at: Double(step) * 0.01)
            XCTAssertGreaterThanOrEqual(scale, FlowerMotion.blinkClosedScale - 1e-9)
            XCTAssertLessThanOrEqual(scale, 1)
        }
    }

    func testBlinkActuallyClosesDuringACycle() {
        var minimum = 1.0
        for step in 0..<1000 {
            let t = FlowerMotion.blinkPeriod * Double(step) / 1000
            minimum = min(minimum, FlowerMotion.blinkScale(seed: 0, at: t))
        }
        XCTAssertEqual(minimum, FlowerMotion.blinkClosedScale, accuracy: 0.01)
    }

    /// A roster must not blink in lockstep — the reason the seed exists.
    func testTwoSeedsNeverShareAPhase() {
        let first = (0..<570).map { FlowerMotion.blinkScale(seed: 0, at: Double($0) * 0.01) }
        let second = (0..<570).map { FlowerMotion.blinkScale(seed: 0.5, at: Double($0) * 0.01) }
        XCTAssertNotEqual(first, second)
    }

    // MARK: - Float

    func testFloatIsBoundedAndReturnsToRestEachPeriod() {
        XCTAssertEqual(FlowerMotion.floatOffset(at: 0), 0, accuracy: 1e-9)
        XCTAssertEqual(FlowerMotion.floatOffset(at: FlowerMotion.floatPeriod), 0, accuracy: 1e-9)
        XCTAssertEqual(FlowerMotion.floatOffset(at: FlowerMotion.floatPeriod / 2), -2, accuracy: 1e-9)
        for step in 0..<600 {
            let value = FlowerMotion.floatOffset(at: Double(step) * 0.05)
            XCTAssertGreaterThanOrEqual(value, -2 - 1e-9)
            XCTAssertLessThanOrEqual(value, 1e-9)
        }
    }

    // MARK: - Speech

    func testSpeakingPulseIsBoundedAndCentredOnRest() {
        var minimum = Double.infinity
        var maximum = -Double.infinity
        var total = 0.0
        let samples = 6000
        for step in 0..<samples {
            let value = FlowerMotion.speakingScale(at: Double(step) * 0.01)
            minimum = min(minimum, value)
            maximum = max(maximum, value)
            total += value
        }
        XCTAssertEqual(minimum, 0.94, accuracy: 0.01)
        XCTAssertEqual(maximum, 1.06, accuracy: 0.01)
        // Two whole numbers of cycles in the sampled span, so the mean is rest.
        XCTAssertEqual(total / Double(samples), 1.0, accuracy: 0.01)
    }

    func testSpeakingPulseActuallyMoves() {
        let values = (0..<200).map { FlowerMotion.speakingScale(at: Double($0) * 0.01) }
        XCTAssertGreaterThan(values.max()! - values.min()!, 0.05)
    }

    // MARK: - Gaze

    func testGazeOffsetClampsToItsRange() {
        XCTAssertEqual(FlowerMotion.gazeOffset(2, range: 7), 7)
        XCTAssertEqual(FlowerMotion.gazeOffset(-3, range: 5), -5)
        XCTAssertEqual(FlowerMotion.gazeOffset(0.5, range: 7), 3.5, accuracy: 1e-9)
        XCTAssertEqual(FlowerMotion.gazeOffset(1, range: 0), 0)
    }

    // MARK: - Seed

    func testSeedIsStableInRangeAndDifferentPerName() {
        XCTAssertEqual(FlowerMotion.seed(for: "alpha"), FlowerMotion.seed(for: "alpha"))
        XCTAssertNotEqual(FlowerMotion.seed(for: "alpha"), FlowerMotion.seed(for: "beta"))
        for value in ["", "a", "bot-1", "a-very-long-bot-name-that-keeps-going", String(repeating: "x", count: 200)] {
            let seed = FlowerMotion.seed(for: value)
            XCTAssertGreaterThanOrEqual(seed, 0)
            XCTAssertLessThan(seed, 1)
        }
    }
}

/// The artwork the core now owns: one body path, two eye anchors, one palette.
final class FlowerArtworkTests: XCTestCase {

    func testBodyStartsWithTheAuthoredMoveAndEndsClosed() {
        let body = FlowerArtwork.body
        XCTAssertFalse(body.isEmpty)
        guard case let .move(x, y) = body[0] else {
            return XCTFail("the body must begin with a move")
        }
        XCTAssertEqual(x, 92.79, accuracy: 1e-9)
        XCTAssertEqual(y, 0.33, accuracy: 1e-9)
        XCTAssertEqual(body.last, .close)
        XCTAssertEqual(body.filter { $0 == .close }.count, 1)
    }

    func testBodyIsMostlyCurves() {
        let curves = FlowerArtwork.body.filter {
            if case .curve = $0 { return true }
            return false
        }
        XCTAssertGreaterThan(curves.count, 50)
    }

    func testEyesSitAtTheAuthoredAnchors() {
        XCTAssertEqual(FlowerArtwork.eyes.count, 2)
        XCTAssertEqual(FlowerArtwork.eyes[0].x, -15)
        XCTAssertEqual(FlowerArtwork.eyes[0].y, -2)
        XCTAssertEqual(FlowerArtwork.eyes[1].x, 38)
        XCTAssertEqual(FlowerArtwork.eyes[1].y, -6)
    }

    func testPaletteMatchesTheWebAndFallsBackToTheFlowerOrange() {
        XCTAssertEqual(FlowerArtwork.agentHex.count, 10)
        XCTAssertEqual(FlowerArtwork.agentHex["orange"], "#E78531")
        XCTAssertEqual(FlowerArtwork.agentColorHex("orange"), "#E78531")
        XCTAssertEqual(FlowerArtwork.agentColorHex("no-such-colour"), FlowerArtwork.flowerFallbackHex)
    }
}