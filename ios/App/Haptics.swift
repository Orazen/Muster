// Tap feedback, in one place.
//
// Adapted from the OpenMausBot companion's Haptics helper
// (https://github.com/milind-soni/OpenMausBot, Apache-2.0 — full license
// text and attribution in public/third-party-notices.txt, shipped with
// the app): a selection tick on the controls where a tap is a choice —
// a quick-reply chip, an editor tile, the updates pill.
import UIKit

enum Haptics {
    static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }
}
