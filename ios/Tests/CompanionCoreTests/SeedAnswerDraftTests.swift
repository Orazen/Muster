import XCTest
@testable import CompanionCore

final class SeedAnswerDraftTests: XCTestCase {
    func testCloseAndReopenPreserveExactDraftAndRejectOldOpeningCallbacks() throws {
        var draft = SeedAnswerDraft()
        let first = try XCTUnwrap(draft.openEditor())
        let text = "  Plan\nmy next task  "
        draft.edit(text, in: first)
        draft.closeEditor(first)
        let next = try XCTUnwrap(draft.openEditor())
        draft.edit("stale", in: first)
        draft.closeEditor(first)
        XCTAssertNil(draft.beginAnswer("stale", from: first))
        XCTAssertEqual(draft.opening, next)
        XCTAssertEqual(Array(draft.text.utf16), Array(text.utf16))
    }

    func testEditsPreserveCanonicallyEquivalentButDifferentUTF16() throws {
        var draft = SeedAnswerDraft()
        let token = try XCTUnwrap(draft.openEditor())
        draft.edit("\u{00e9}", in: token)
        let revision = draft.revision
        draft.edit("e\u{0301}", in: token)
        XCTAssertEqual(Array(draft.text.utf16), [0x65, 0x301])
        XCTAssertGreaterThan(draft.revision, revision)
        let action = try XCTUnwrap(draft.beginAnswer(draft.text, from: token))
        XCTAssertEqual(Array(try XCTUnwrap(draft.lastAnswer).utf16), [0x65, 0x301])
        draft.finishAction(action)
        XCTAssertEqual(Array(draft.text.utf16), [0x65, 0x301])
    }

    func testPendingCloseCannotUnlockOrRepeatAndLaterEditsSurviveCompletion() throws {
        var draft = SeedAnswerDraft()
        let opening = try XCTUnwrap(draft.openEditor())
        draft.edit("  Submitted\nanswer  ", in: opening)
        let action = try XCTUnwrap(draft.beginAnswer(draft.text, from: opening))
        draft.edit("Newer unsent draft", in: opening)
        XCTAssertNil(draft.beginAnswer("duplicate", from: opening))
        draft.closeEditor(opening)
        XCTAssertNil(draft.openEditor())
        XCTAssertNil(draft.beginAction())
        draft.finishAction(UUID())
        XCTAssertEqual(draft.pending, action)
        draft.finishAction(action)
        XCTAssertNotNil(draft.openEditor())
        XCTAssertEqual(draft.text, "Newer unsent draft")
        XCTAssertEqual(Array(try XCTUnwrap(draft.lastAnswer).utf16), Array("  Submitted\nanswer  ".utf16))
    }

    func testUTF16LimitAndBlankAnswersNeverStartAnAction() throws {
        var draft = SeedAnswerDraft()
        let opening = try XCTUnwrap(draft.openEditor())
        XCTAssertNil(draft.beginAnswer(" \n\t ", from: opening))
        XCTAssertNil(draft.beginAnswer(String(repeating: "😀", count: 2001), from: opening))
        let text = String(repeating: "😀", count: 2000)
        XCTAssertEqual(text.utf16.count, 4000)
        XCTAssertNotNil(draft.beginAnswer(text, from: opening))
        XCTAssertEqual(Array(try XCTUnwrap(draft.lastAnswer).utf16), Array(text.utf16))
    }

    func testMaskedCardActionsAndInvalidatedEditorCannotDispatch() throws {
        var draft = SeedAnswerDraft()
        let opening = try XCTUnwrap(draft.openEditor())
        XCTAssertNil(draft.beginAction())
        XCTAssertNil(draft.beginAnswer("masked choice"))
        draft.invalidateEditor()
        XCTAssertNil(draft.beginAction(from: opening))
        draft.edit("late", in: opening)
        XCTAssertTrue(draft.text.isEmpty)
        XCTAssertNotNil(draft.beginAction())
    }
}
