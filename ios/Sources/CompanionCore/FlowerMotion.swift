// The flower's expression vocabulary and its motion — platform-free.
//
// Both clients draw the same bot, so both must agree on what it looks like
// when it is working, waiting, or asleep. The pose table used to live only in
// the phone app (`App/FlowerAvatar.swift`), which meant the watch could not
// have it without a second copy, and neither copy was tested. Here it is one
// table, covered by `swift test`, and the drawing stays in the views.
//
// The motion functions are pure functions of time on purpose. A view that
// asks "what is the eyelid scale at t?" can be driven by a TimelineView at
// whatever rate is cheap, the phase is seedable per instance (a roster must
// not blink in lockstep), and the behaviour is verifiable without a screen.
import Foundation

// MARK: - Poses

/// Eye-geometry channels, straight out of the web's `flower.ts`. ViewBox
/// units are the artwork's 224-box; `2`-suffixed channels land on the right
/// eye only.
public struct FlowerPose: Equatable, Sendable {
    public var esx: Double
    public var esy: Double
    public var tilt: Double
    public var edy: Double
    public var edx: Double
    public var esx2: Double
    public var esy2: Double
    public var tilt2: Double
    public var edy2: Double
    public var bdy: Double

    public init(
        esx: Double = 1,
        esy: Double = 1,
        tilt: Double = 0,
        edy: Double = 0,
        edx: Double = 0,
        esx2: Double = 0,
        esy2: Double = 0,
        tilt2: Double = 0,
        edy2: Double = 0,
        bdy: Double = 0
    ) {
        self.esx = esx
        self.esy = esy
        self.tilt = tilt
        self.edy = edy
        self.edx = edx
        self.esx2 = esx2
        self.esy2 = esy2
        self.tilt2 = tilt2
        self.edy2 = edy2
        self.bdy = bdy
    }

    /// The resting value of each channel, in the order `channels` reports.
    /// A pose "changes" a channel when it differs from this.
    static let defaults: [Double] = [1, 1, 0, 0, 0, 0, 0, 0, 0, 0]

    /// Every channel in a fixed order, so callers can count how many a pose
    /// actually moves without knowing the field names.
    public var channels: [Double] { [esx, esy, tilt, edy, edx, esx2, esy2, tilt2, edy2, bdy] }
}

/// `FLOWER_POSES`, verbatim from the web. Every pose differs from idle on at
/// least three channels — asserted by `flower.test.ts` there and by
/// `FlowerMotionTests` here — so no pose ever reads as "idle with a tint".
public let FLOWER_POSES: [String: FlowerPose] = [
    "idle": FlowerPose(),
    "happy": FlowerPose(esx: 1.72, esy: 0.3, tilt: 8, edy: -3.3, edx: 3.3, esx2: 0.08, esy2: 0.05, tilt2: -16, bdy: -4.8),
    "sad": FlowerPose(esx: 0.6, esy: 0.56, tilt: 26, edy: 7.9, edx: 4.2, esx2: -0.05, esy2: -0.07, tilt2: -7, bdy: 5.7),
    "mad": FlowerPose(esx: 1.85, esy: 0.26, tilt: -33, edy: 0.9, edx: 1.3, tilt2: 5, bdy: 1.8),
    "surprised": FlowerPose(esx: 1.34, esy: 1.2, tilt: -6, edy: -2.3, edx: 1.1, esx2: 0.05, esy2: 0.07, bdy: -3.1),
    "wink": FlowerPose(esx: 1.32, esy: 0.76, tilt: 5, edy: -1.3, edx: 1.8, esx2: 0.26, esy2: -0.56, tilt2: -11, bdy: -2.4),
    "sleepy": FlowerPose(esx: 1.14, esy: 0.22, tilt: 0, edy: 5.3, edx: 0.7, tilt2: 4, bdy: 2.6),
    "smug": FlowerPose(esx: 1.3, esy: 0.42, tilt: 18, edy: -1.1, edx: 1.1, tilt2: -36, bdy: -2.2),
    "unsure": FlowerPose(esx: 0.95, esy: 1.02, tilt: 4, edy: -0.4, edx: 0.7, esx2: 0.24, esy2: -0.44, tilt2: -18),
    "scared": FlowerPose(esx: 0.78, esy: 0.96, tilt: -12, edy: -3.3, edx: -1.8, tilt2: 4),
    "love": FlowerPose(esx: 0.86, esy: 1.28, tilt: -14, edy: -1.1, edx: -0.8, esy2: 0.06, bdy: -3.5),
    "shy": FlowerPose(esx: 0.62, esy: 0.5, tilt: 10, edy: 3.1, edx: -0.4, esy2: -0.04, bdy: 2.0),
    "sick": FlowerPose(esx: 1.25, esy: 0.34, tilt: 20, edy: 4.0, edx: 1.8, tilt2: -6, bdy: 3.1),
    "thinking": FlowerPose(esx: 1.15, esy: 0.62, tilt: 0, edy: 9.2, edx: 0.9, edy2: -18.5),
    "focused": FlowerPose(esx: 1.45, esy: 0.5, tilt: -12, edy: 0.9, edx: 0.9, bdy: 1.1),
]

/// True when a string names a pose exactly. Guards typos in the mapping.
public func isFlowerPoseName(_ name: String) -> Bool { FLOWER_POSES[name] != nil }

/// The state string for a bot, matching the top of the web's `stateForBot`:
/// a pinned expression wins, then busy, then unread. The web's profile-keyword
/// guessing needs the full bot profile, which neither roster's record carries,
/// so those bots rest at idle. Shared so the phone and the watch cannot
/// disagree about what a bot is doing.
public func flowerState(for bot: Bot) -> String {
    if let pinned = bot.mascotExpression, !pinned.isEmpty { return pinned }
    if bot.busy == true { return "working" }
    if bot.unread { return "notifying" }
    return "idle"
}

/// `poseFor` from the web — the same keyword chain, so a state string lands
/// on the same pose on every screen. Unknown input falls back to idle.
public func flowerPoseFor(_ state: String?) -> FlowerPose {
    let key = (state ?? "idle").lowercased()
    if let named = FLOWER_POSES[key] { return named }
    let chains: [(String, String)] = [
        ("happy|excit|proud|playful|celebrat|laugh|love|success", "happy"),
        ("sleep|drows|rest|night|bored|powering", "sleepy"),
        ("think|search|load|plan|read|progress|orbit|confus|unsure", "thinking"),
        ("work|writ|build|run|send|upload|dictat|focus|typing", "focused"),
        ("angry|mad|fail|error|alert", "mad"),
        ("surpris|curious|spawn|wake|listen|notif|wink", "surprised"),
        ("suspicious|review|audit|wary|radar|smug", "smug"),
        ("scared|shy|sad|drag", "scared"),
        ("sick|hungover", "sick"),
    ]
    for (pattern, pose) in chains where key.range(of: pattern, options: .regularExpression) != nil {
        return FLOWER_POSES[pose] ?? FlowerPose()
    }
    return FlowerPose()
}

// MARK: - Motion

/// Every moving part of the flower, as a pure function of time.
///
/// Timings are the web's so the two screens feel identical: a 5.7s blink
/// cycle (`flower-bot-blink`) and a 6s float (`flower-bot-float`). Speech has
/// no web counterpart — the browser never speaks — so it is new here, and it
/// is a body pulse because the flower has no mouth and the pose vocabulary
/// forbids adding marks.
public enum FlowerMotion {
    /// Seconds per blink, from `flower-bot-blink`.
    public static let blinkPeriod: Double = 5.7
    /// Fraction of the cycle at which the eyelid is fully closed.
    static let blinkCentre: Double = 0.47
    /// Half-width of the closing window, in cycles. 0.02 each side is the
    /// CSS keyframe's 45%→49% span — ~0.23s, a blink rather than a squint.
    static let blinkHalfWidth: Double = 0.02
    /// The web's fully-closed eyelid scale.
    public static let blinkClosedScale: Double = 0.08

    /// Seconds per float, from `flower-bot-float`.
    public static let floatPeriod: Double = 6

    /// Eyelid Y scale at `t` seconds, for an instance whose `seed` is in
    /// 0..<1. Returns `blinkClosedScale` mid-blink and 1 outside it, eased so
    /// there is no visible cut.
    public static func blinkScale(seed: Double, at t: Double) -> Double {
        let phase = unitPhase(t / blinkPeriod + seed)
        let distance = abs(phase - blinkCentre)
        guard distance < blinkHalfWidth else { return 1 }
        // 0 at the window edge, 1 at its centre.
        let closure = 1 - distance / blinkHalfWidth
        return 1 - (1 - blinkClosedScale) * closure
    }

    /// Whole-body vertical offset in viewBox units: 0 at rest, -2 at the top
    /// of the cycle. Matches `flower-bot-float`'s `translateY(-2px)`.
    public static func floatOffset(at t: Double) -> Double {
        -1 + cos(2 * .pi * t / floatPeriod)
    }

    /// Body scale while a reply is being spoken, roughly 1.0…1.06.
    ///
    /// Two incommensurate frequencies rather than one, so it reads as speech
    /// instead of a metronome. Bounded by construction: the amplitudes sum to
    /// 0.06.
    public static func speakingScale(at t: Double) -> Double {
        1 + 0.04 * sin(2 * .pi * 4.3 * t) + 0.02 * sin(2 * .pi * 7.1 * t)
    }

    /// Eye offset in viewBox units for a signed -1…1 gaze component and a
    /// per-instance reach. Clamped, so a caller cannot drive an eye off the
    /// face with a bad value.
    public static func gazeOffset(_ unit: Double, range: Double) -> Double {
        max(-1, min(1, unit)) * range
    }

    /// A stable 0..<1 phase offset from a string, so two bots in a roster
    /// never blink on the same frame. FNV-1a, the same spirit as the web's
    /// `hashSeed` in `FlowerBot.tsx`.
    public static func seed(for value: String) -> Double {
        var hash: UInt32 = 2166136261
        for byte in value.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 16777619
        }
        return Double(hash % 1000) / 1000
    }

    /// `t` wrapped into 0..<1, with negatives handled so a clock that steps
    /// backwards does not produce a negative phase.
    static func unitPhase(_ value: Double) -> Double {
        let wrapped = value.truncatingRemainder(dividingBy: 1)
        return wrapped < 0 ? wrapped + 1 : wrapped
    }
}