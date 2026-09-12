// The bot's face — the app-icon flower, the same geometry the web draws.
//
// The desktop's default teammate body is the authored flower
// (`src/lib/musterbot/FlowerBot.tsx`, body path from `MusterMascot.tsx`,
// the artwork emitted to /app-icon.svg). The phone used to draw the older
// cursor mascot, so a bot you know by its shape looked like a different
// bot on the two screens. This is that flower, verbatim: the same body
// path, the same capsule eyes at the same coordinates, and the same pose
// channels (`flower.ts`) — eye scale/offset/tilt about each eye's own
// centre, plus a whole-body offset. No added marks, no blinking, no
// motion engine: at roster sizes the web's animation would show as
// nothing, and the pose table is the part that carries identity.
//
// Poses are truthful status only — busy reads as focused, unread as the
// same raised look the web's "notifying" maps to. A face never stands in
// for approval, uncertainty or completion text; those always arrive as
// words on the cards and in the transcript.
import SwiftUI
import CompanionCore

/// Eye-geometry channels, straight out of `flower.ts`. ViewBox units are
/// the artwork's 224-box; `2`-suffixed channels land on the right eye only.
struct FlowerPose {
    var esx: Double = 1
    var esy: Double = 1
    var tilt: Double = 0
    var edy: Double = 0
    var edx: Double = 0
    var esx2: Double = 0
    var esy2: Double = 0
    var tilt2: Double = 0
    var edy2: Double = 0
    var bdy: Double = 0
}

/// `FLOWER_POSES`, verbatim. Every pose differs from idle on at least three
/// channels (asserted by `flower.test.ts` on the web side).
let FLOWER_POSES: [String: FlowerPose] = [
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

/// `poseFor` from `flower.ts` — the same keyword chain, so a state string
/// lands on the same pose on both screens. Unknown input falls back to idle.
func flowerPoseFor(_ state: String?) -> FlowerPose {
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

/// The states the phone actually knows, matching the top of the web's
/// `stateForBot`: a pinned expression wins, then busy, then unread. The
/// web's profile-keyword guessing needs the full bot profile, which the
/// roster's Chat record does not carry — those bots simply rest at idle.
func flowerState(for bot: Bot) -> String {
    if let pinned = bot.mascotExpression, !pinned.isEmpty { return pinned }
    if bot.busy == true { return "working" }
    if bot.unread { return "notifying" }
    return "idle"
}

/// The flower, at whatever size the row needs.
struct FlowerAvatar: View {
    /// An `AGENT_COLORS` name; an unknown name falls back to the brand
    /// orange, exactly as the web's FlowerBot does.
    let color: String
    var size: CGFloat = 52
    /// Any state string the web would pass — run through `flowerPoseFor`.
    var state: String = "idle"

    /// MusterMascot's MUSTER_BODY — only `M`, `C` and `Z` appear, so the
    /// small parser below is enough. Verbatim from the web source.
    private static let bodyPath =
        """
        M92.79 0.33C91.27 3.35 89.38 6.32 87 8.93C84.61 11.55 82.11 14.13 78.48 16.01C74.85 17.88 66.56 17.93 65.21 20.2C63.86 22.47 68.79 26.23 70.37 29.61C71.96 32.98 73.87 36.88 74.73 40.45C75.59 44.01 75.71 47.58 75.52 51.01C75.33 54.43 74.63 57.83 73.61 61C72.58 64.17 71.12 67.24 69.39 70.02C67.66 72.81 65.54 75.42 63.21 77.7C60.88 79.97 58.22 82.01 55.42 83.66C52.62 85.32 49.55 86.68 46.43 87.62C43.3 88.57 39.97 89.17 36.67 89.33C33.37 89.49 29.93 89.28 26.61 88.59C23.29 87.89 19.91 86.84 16.74 85.15C13.57 83.47 10.4 82.24 7.6 78.47C4.79 74.7 2.48 62.54 -0.08 62.54C-2.63 62.54 -4.94 74.7 -7.75 78.47C-10.55 82.24 -13.72 83.47 -16.89 85.15C-20.06 86.84 -23.44 87.89 -26.76 88.59C-30.08 89.28 -33.52 89.49 -36.82 89.33C-40.12 89.17 -43.45 88.57 -46.58 87.62C-49.7 86.68 -52.77 85.32 -55.57 83.66C-58.37 82.01 -61.03 79.97 -63.36 77.7C-65.69 75.42 -67.81 72.81 -69.54 70.02C-71.27 67.24 -72.74 64.17 -73.76 61C-74.78 57.83 -75.48 54.43 -75.67 51.01C-75.86 47.58 -75.74 44.01 -74.88 40.45C-74.02 36.88 -72.11 32.98 -70.52 29.61C-68.94 26.23 -64.01 22.47 -65.36 20.2C-66.71 17.93 -75 17.88 -78.63 16.01C-82.26 14.13 -84.76 11.55 -87.15 8.93C-89.53 6.32 -91.42 3.35 -92.94 0.33C-94.46 -2.69 -95.56 -5.95 -96.27 -9.18C-96.97 -12.41 -97.27 -15.78 -97.18 -19.05C-97.1 -22.32 -96.6 -25.65 -95.74 -28.79C-94.89 -31.93 -93.63 -35.04 -92.06 -37.9C-90.48 -40.75 -88.52 -43.5 -86.3 -45.91C-84.07 -48.33 -81.49 -50.56 -78.7 -52.38C-75.9 -54.21 -72.81 -55.79 -69.53 -56.86C-66.25 -57.93 -62.77 -58.77 -59.02 -58.81C-55.27 -58.84 -50.24 -57 -47.03 -57.08C-43.82 -57.15 -41.16 -56.77 -39.76 -59.26C-38.36 -61.76 -39.58 -68.26 -38.63 -72.04C-37.67 -75.81 -35.91 -78.96 -34.02 -81.9C-32.13 -84.84 -29.78 -87.43 -27.29 -89.68C-24.79 -91.92 -21.96 -93.83 -19.05 -95.36C-16.13 -96.89 -12.97 -98.06 -9.81 -98.83C-6.65 -99.61 -3.32 -100 -0.08 -100C3.17 -100 6.5 -99.61 9.66 -98.83C12.82 -98.06 15.98 -96.89 18.9 -95.36C21.81 -93.83 24.64 -91.92 27.14 -89.68C29.63 -87.43 31.98 -84.84 33.87 -81.9C35.76 -78.96 37.52 -75.81 38.48 -72.04C39.43 -68.26 38.21 -61.76 39.61 -59.26C41.01 -56.77 43.67 -57.15 46.88 -57.08C50.09 -57 55.12 -58.84 58.87 -58.81C62.62 -58.77 66.1 -57.93 69.38 -56.86C72.66 -55.79 75.75 -54.21 78.55 -52.38C81.34 -50.56 83.92 -48.33 86.15 -45.91C88.37 -43.5 90.33 -40.75 91.91 -37.9C93.48 -35.04 94.74 -31.93 95.59 -28.79C96.45 -25.65 96.94 -22.32 97.03 -19.05C97.12 -15.78 96.82 -12.41 96.12 -9.18C95.41 -5.95 94.31 -2.69 92.79 0.33Z
        """

    /// Parsed once — a chat list is hundreds of avatars redrawn on scroll.
    private static let body: Path = parse(bodyPath)

    private static let eyes: [(x: Double, y: Double)] = [(-15, -2), (38, -6)]

    var body: some View {
        Canvas { context, canvasSize in
            // The web renders a square 224×224 viewBox centred on the origin.
            let scale = min(canvasSize.width, canvasSize.height) / 224
            let centre = CGPoint(x: canvasSize.width / 2, y: canvasSize.height / 2)

            var bodyContext = context
            bodyContext.translateBy(x: centre.x, y: centre.y)
            bodyContext.scaleBy(x: scale, y: scale)
            let pose = flowerPoseFor(state)
            // whole-body vertical offset, +=down, in viewBox units
            bodyContext.translateBy(x: 0, y: pose.bdy)
            bodyContext.fill(Self.body, with: .color(flowerColor))

            for (index, eye) in Self.eyes.enumerated() {
                // each eye: place it, then the artwork's authored -4° tilt
                var eyeContext = bodyContext
                eyeContext.translateBy(x: eye.x, y: eye.y)
                eyeContext.rotate(by: .degrees(-4))

                // then the pose channels, composed about the eye's own
                // centre — identical math to FlowerBot's eyeTransform
                let wrap: Double = index == 0 ? -1 : 1
                let sel: Double = index == 0 ? 0 : 1
                let dx = pose.edx * wrap
                let dy = pose.edy + pose.edy2 * sel
                let tilt = pose.tilt * wrap + pose.tilt2 * sel
                let sx = pose.esx * (1 + pose.esx2 * sel)
                let sy = pose.esy * (1 + pose.esy2 * sel)
                eyeContext.translateBy(x: dx, y: dy)
                eyeContext.rotate(by: .degrees(tilt))
                eyeContext.scaleBy(x: sx, y: sy)

                // the portrait capsule: x -10.5, y -22, 21×44, rx 10.5
                let capsule = CGRect(x: -10.5, y: -22, width: 21, height: 44)
                eyeContext.fill(
                    Path(roundedRect: capsule, cornerRadius: 10.5),
                    with: .color(Color(hex: "#f9f9f9"))
                )
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private var flowerColor: Color {
        Color(hex: AgentPalette.agentHex[color] ?? "#f08a24")
    }
}

private func parse(_ d: String) -> Path {
    var raw = Path()
    var numbers: [Double] = []
    var command: Character?
    var current = CGPoint.zero

    func flush() {
        guard let command else { return }
        switch command {
        case "M":
            guard numbers.count >= 2 else { break }
            current = CGPoint(x: numbers[0], y: numbers[1])
            raw.move(to: current)
        case "C":
            // several curves may follow one C, six numbers each
            var i = 0
            while i + 5 < numbers.count {
                let to = CGPoint(x: numbers[i + 4], y: numbers[i + 5])
                raw.addCurve(
                    to: to,
                    control1: CGPoint(x: numbers[i], y: numbers[i + 1]),
                    control2: CGPoint(x: numbers[i + 2], y: numbers[i + 3])
                )
                current = to
                i += 6
            }
        default:
            break
        }
        numbers.removeAll()
    }

    var token = ""
    func takeNumber() {
        if !token.isEmpty, let value = Double(token) { numbers.append(value) }
        token = ""
    }

    for character in d {
        if character.isNumber || character == "." || character == "e" {
            token.append(character)
        } else if character == "-" {
            // a minus starts a new number unless it is an exponent sign
            if token.hasSuffix("e") { token.append(character) } else { takeNumber(); token = "-" }
        } else if character == " " || character == "," || character == "\n" {
            takeNumber()
        } else if character == "Z" || character == "z" {
            takeNumber(); flush(); raw.closeSubpath(); command = nil
        } else {
            takeNumber(); flush(); command = character
        }
    }
    takeNumber()
    flush()
    return raw
}
