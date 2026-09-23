import XCTest
@testable import CompanionCore

/// The chip row's list is edited on one screen and read on another, with
/// UserDefaults as the only thing between them — so the decode rules are
/// the contract: never lose a deliberate edit, never keep an unreadable
/// one, and never let two chips claim the same identity.
final class QuickRepliesTests: XCTestCase {

    func testNeverWrittenStorageReadsAsTheFourDefaults() {
        let replies = QuickReply.decode("")
        XCTAssertEqual(replies, QuickReply.defaults)
        XCTAssertEqual(replies.map(\.id), ["default.diff", "default.tests", "default.explain", "default.next"])
    }

    func testMalformedJSONReadsAsTheDefaults() {
        XCTAssertEqual(QuickReply.decode("not json at all"), QuickReply.defaults)
        XCTAssertEqual(QuickReply.decode("{\"title\":\"half an object\"}"), QuickReply.defaults)
    }

    func testDeliberatelyClearedListStaysEmpty() {
        // `""` means never written; `"[]"` means the person emptied the
        // row. Falling back to the defaults here would resurrect chips
        // they threw out.
        XCTAssertEqual(QuickReply.decode(QuickReply.encode([])), [])
    }

    func testRoundTripPreservesOrderAndContent() {
        let replies = [
            QuickReply(id: "a", title: "Ship it", prompt: "Run the release checklist", icon: "hammer"),
            QuickReply(id: "b", title: "Status", prompt: "Summarize where this task stands", icon: "list.bullet"),
        ]
        XCTAssertEqual(QuickReply.decode(QuickReply.encode(replies)), replies)
    }

    func testDuplicateIdsReadAsTheDefaults() {
        let json = QuickReply.encode([
            QuickReply(id: "same", title: "One", prompt: "First", icon: "sparkles"),
            QuickReply(id: "same", title: "Two", prompt: "Second", icon: "terminal"),
        ])
        XCTAssertEqual(QuickReply.decode(json), QuickReply.defaults)
    }

    func testBlankIdReadsAsTheDefaults() {
        let json = QuickReply.encode([QuickReply(id: "   ", title: "Ghost", prompt: "Boo", icon: "sparkles")])
        XCTAssertEqual(QuickReply.decode(json), QuickReply.defaults)
    }

    func testDefaultsAreFourDistinctFullyFormedChips() {
        XCTAssertEqual(QuickReply.defaults.count, 4)
        XCTAssertEqual(Set(QuickReply.defaults.map(\.id)).count, 4)
        for reply in QuickReply.defaults {
            XCTAssertFalse(reply.title.isEmpty)
            XCTAssertFalse(reply.prompt.isEmpty)
            XCTAssertTrue(QuickReply.iconChoices.contains(reply.icon))
        }
    }

    func testEveryEditorIconChoiceIsNonEmpty() {
        XCTAssertFalse(QuickReply.iconChoices.isEmpty)
        XCTAssertEqual(Set(QuickReply.iconChoices).count, QuickReply.iconChoices.count)
        XCTAssertTrue(QuickReply.iconChoices.allSatisfy { !$0.isEmpty })
    }
}
