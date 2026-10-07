import AppKit
import CompanionCore
import Foundation
import SwiftUI
import XCTest
import Vision
@testable import MusterMac
@testable import MusterMacCore

// The real detail view over the real live model, hosted headlessly. Only the
// transport is synthetic: no endpoint, account, Keychain or installed app is
// used. Every owned stream continuation is drained during teardown.
private actor RoomConversationTransport: NativeSessionTransport {
    let fleet: Fleet
    private var stream: CheckedContinuation<Void, Error>?
    private var onEvent: (@Sendable (StreamFrame) -> Void)?
    private var closed = false
    private(set) var sentBotIds: [String] = []

    init(fleet: Fleet) { self.fleet = fleet }
    func roster(messages: Int) async throws -> Fleet { fleet }
    func memory(botId: String) async throws -> String { "synthetic" }
    func send(text: String, to botId: String, clientIntentId: String) async throws -> SendReceipt {
        sentBotIds.append(botId)
        return SendReceipt(intentId: clientIntentId, messageId: "sent", threadId: "bot-thread", state: "accepted")
    }
    func respond(botId: String, requestId: String, behavior: String, message: String?) async throws -> MusterMacCore.ApprovalOutcome {
        throw URLError(.unsupportedURL)
    }
    func events(lastEventId: String?, onEvent: @escaping @Sendable (StreamFrame) -> Void,
                onHello: @escaping @Sendable (String, Bool) -> Void) async throws {
        guard !closed else { throw CancellationError() }
        self.onEvent = onEvent
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            if closed { continuation.resume(throwing: CancellationError()) }
            else { stream = continuation }
        }
    }
    var streamReady: Bool { stream != nil }
    func deleteRoom(_ id: String) { onEvent?(StreamFrame(frame: .roomDeleted(groupId: id), seq: 1)) }
    func finish() {
        closed = true
        onEvent = nil
        stream?.resume(throwing: CancellationError())
        stream = nil
    }
}

@MainActor
final class RoomConversationAcceptanceUITests: XCTestCase {
    private struct RenderEvidence: Encodable {
        let rootFrame: String
        let rootBounds: String
        let windowFrame: String?
        let windowVisible: Bool
        let appearance: String
        let pixelWidth: Int
        let pixelHeight: Int
        let recognized: [String]
        let pngBytes: Int
        let pngBase64: String?
    }

    private var latestRenderEvidence = ""

    private func fleet(roomMessages: Bool = true, bots: Bool = true) throws -> Fleet {
        var sample = FixtureFleet.standard().fleet
        let message = try JSONDecoder().decode(Message.self, from: Data(#"{"id":"room-message","role":"bot","kind":"text","at":1,"text":"Room transcript from its own thread"}"#.utf8))
        sample.groups[0].messages = roomMessages ? [message] : []
        if bots {
            sample.bots = [sample.bots[0]]
            let botMessage = try JSONDecoder().decode(Message.self, from: Data(#"{"id":"bot-message","role":"bot","kind":"text","at":1,"text":"Bot transcript stays separate"}"#.utf8))
            sample.bots[0].messages = [botMessage]
        } else { sample.bots = [] }
        return sample
    }

    private static func pump() { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }

    private func drain() async throws {
        for _ in 0..<8 {
            Self.pump()
            try await Task.sleep(nanoseconds: 4_000_000)
        }
    }

    private func scope(_ fleet: Fleet) async throws -> (LiveSessionModel, RoomConversationTransport) {
        let transport = RoomConversationTransport(fleet: fleet)
        let live = LiveSessionModel(transportFactory: { _ in transport })
        live.connect(account: HarnessAccount(origin: "https://room.fixture.invalid", cookieName: "synthetic", cookieValue: "synthetic"))
        addTeardownBlock { @MainActor in
            live.disconnect()
            await transport.finish()
            let streamReady = await transport.streamReady
            XCTAssertFalse(streamReady, "Owned stream must be drained")
        }
        for _ in 0..<20 {
            if live.state == .live, await transport.streamReady { break }
            try await drain()
        }
        XCTAssertEqual(live.state, .live)
        let streamReady = await transport.streamReady
        XCTAssertTrue(streamReady)
        return (live, transport)
    }

    private func host(_ live: LiveSessionModel) async throws -> NSHostingView<AnyView> {
        try await hostView(LiveConversationView().environmentObject(live))
    }

    private func hostView(_ content: some View) async throws -> NSHostingView<AnyView> {
        // Pin the SwiftUI proposal as well as AppKit's frame. The unshown
        // window is a fixed render canvas, not an intrinsic-size app window.
        let hosting = NSHostingView(rootView: AnyView(content
            .frame(width: 850, height: 650)
            .background(MusterAppearance.canvas)))
        hosting.frame = NSRect(x: 0, y: 0, width: 850, height: 650)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.contentView = hosting
        hosting.layoutSubtreeIfNeeded()
        addTeardownBlock { @MainActor in
            // Existing headless harness measured close() crashing; detach only.
            window.contentView = NSView(frame: .zero)
            Self.pump()
            XCTAssertNil(hosting.window, "Owned render view must be detached")
        }
        try await drain()
        XCTAssertEqual(hosting.bounds.size, NSSize(width: 850, height: 650))
        XCTAssertFalse(window.isVisible, "Owned bitmap tests must never show a window")
        return hosting
    }

    // Some SwiftUI labels are drawn directly, and an unshown headless window
    // exposes no accessibility children. Recognize the real hosted pixels
    // locally instead of weakening the positive header/unavailable assertions.
    // This is this owned view's bitmap, never a screen capture or a cloud API.
    private func labels(_ root: NSView) throws -> [String] {
        root.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(root.bitmapImageRepForCachingDisplay(in: root.bounds))
        root.cacheDisplay(in: root.bounds, to: bitmap)
        let image = try XCTUnwrap(bitmap.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        let recognized = try XCTUnwrap(request.results).compactMap { $0.topCandidates(1).first?.string }
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        let evidence = RenderEvidence(
            rootFrame: NSStringFromRect(root.frame), rootBounds: NSStringFromRect(root.bounds),
            windowFrame: root.window.map { NSStringFromRect($0.frame) },
            windowVisible: root.window?.isVisible ?? false,
            appearance: root.effectiveAppearance.name.rawValue,
            pixelWidth: image.width, pixelHeight: image.height,
            recognized: Array(recognized.prefix(32)).map { String($0.prefix(256)) },
            pngBytes: png.count, pngBase64: png.count <= 256 * 1024 ? png.base64EncodedString() : nil)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        latestRenderEvidence = String(decoding: try encoder.encode(evidence), as: UTF8.self)
        XCTAssertFalse(recognized.isEmpty, "An empty rendering cannot satisfy acceptance\nROOM_RENDER_DIAGNOSTIC \(latestRenderEvidence)")
        return recognized + textFields(root).flatMap { [$0.stringValue, $0.placeholderString ?? ""] }
    }

    private func unavailableFailure(_ text: String) -> String {
        // Only assertion diagnostics contain the bounded owned bitmap. They
        // never enter labels(), the positive predicate, or a fallback oracle.
        text.contains("No conversation selected") ? text
            : "\(text)\nROOM_RENDER_DIAGNOSTIC \(latestRenderEvidence)"
    }

    private func textFields(_ root: NSView) -> [NSTextField] {
        var fields: [NSTextField] = []
        func visit(_ node: NSView) {
            if let field = node as? NSTextField { fields.append(field) }
            node.subviews.forEach(visit)
        }
        visit(root)
        return fields
    }

    func testSelectedRoomRendersItsOwnHeaderAndTranscript() async throws {
        let roster = try fleet()
        let (live, _) = try await scope(roster)
        live.selectedThreadId = roster.groups[0].threadId
        let view = try await host(live)
        let text = try labels(view).joined(separator: "\n")
        XCTAssertTrue(text.contains("Launch prep"), text)
        XCTAssertTrue(text.contains("Room transcript from its own thread"), text)
        XCTAssertFalse(text.contains("Bot transcript stays separate"), text)
        XCTAssertFalse(text.contains("No conversation selected"), text)
        XCTAssertTrue(textFields(view).contains { $0.placeholderString == "Room messaging is unavailable on this Mac" && !$0.isEnabled })
    }

    func testRoomOnlyRosterDefaultSelectionRendersConversation() async throws {
        let roster = try fleet(bots: false)
        let (live, _) = try await scope(roster)
        XCTAssertEqual(live.selectedThreadId, roster.groups[0].threadId)
        let text = try labels(try await host(live)).joined(separator: "\n")
        XCTAssertTrue(text.contains("Launch prep"), text)
        XCTAssertTrue(text.contains("Room transcript from its own thread"), text)
    }

    func testEmptyRoomKeepsItsIdentityAndRoomEmptyState() async throws {
        let roster = try fleet(roomMessages: false, bots: false)
        let (live, _) = try await scope(roster)
        let text = try labels(try await host(live)).joined(separator: "\n")
        XCTAssertTrue(text.contains("Launch prep"), text)
        XCTAssertTrue(text.contains("No messages in this room yet."), text)
        XCTAssertFalse(text.contains("This teammate has no conversation yet."), text)
        XCTAssertFalse(text.contains("No conversation selected"), text)
    }

    func testDeletedRoomStopsShowingCachedTranscript() async throws {
        let roster = try fleet(bots: false)
        let (live, transport) = try await scope(roster)
        let view = try await host(live)
        XCTAssertTrue(try labels(view).joined().contains("Room transcript from its own thread"))
        await transport.deleteRoom(roster.groups[0].id)
        try await drain()
        let text = try labels(view).joined(separator: "\n")
        XCTAssertTrue(live.fleet.groups.isEmpty)
        XCTAssertTrue(text.contains("No conversation selected"), unavailableFailure(text))
        XCTAssertFalse(text.contains("Room transcript from its own thread"), text)
        XCTAssertFalse(text.contains("Launch prep"), text)
    }

    func testRoomCannotSendThroughBotTransportAndSwitchBackPreservesBot() async throws {
        let roster = try fleet()
        let (live, transport) = try await scope(roster)
        live.selectedThreadId = roster.groups[0].threadId
        let view = try await host(live)
        live.draft = "Keep this draft"
        await live.sendDraft()
        let roomSends = await transport.sentBotIds
        XCTAssertEqual(roomSends, [])
        XCTAssertEqual(live.draft, "Keep this draft")
        XCTAssertTrue(live.pendingSends.isEmpty)
        live.selectedThreadId = roster.bots[0].threadId
        try await drain()
        let text = try labels(view).joined(separator: "\n")
        XCTAssertTrue(text.contains("Scout"), text)
        XCTAssertTrue(text.contains("Bot transcript stays separate"), text)
        XCTAssertFalse(text.contains("Room transcript from its own thread"), text)
        XCTAssertTrue(textFields(view).contains { $0.isEditable && $0.isEnabled })
        await live.sendDraft()
        let botSends = await transport.sentBotIds
        XCTAssertEqual(botSends, [roster.bots[0].id])
    }

    func testUnknownSelectionIsUnavailable() async throws {
        let (live, _) = try await scope(fleet())
        live.selectedThreadId = "unknown-thread"
        let text = try labels(try await host(live)).joined(separator: "\n")
        XCTAssertTrue(text.contains("No conversation selected"), unavailableFailure(text))
        XCTAssertFalse(text.contains("Room transcript from its own thread"), text)
        XCTAssertFalse(text.contains("Bot transcript stays separate"), text)
    }

    func testUnavailableCanvasRequiresActualRenderedLabel() async throws {
        let unavailable = try await hostView(VStack(spacing: 0) {
            Text("Muster").font(.caption2)
            Divider()
            ContentUnavailableView("No conversation selected", systemImage: "bubble.left.and.text.bubble.right")
        })
        let positive = try labels(unavailable).joined(separator: "\n")
        XCTAssertTrue(positive.contains("No conversation selected"), unavailableFailure(positive))

        let different = try await hostView(VStack(spacing: 0) {
            Text("Muster").font(.caption2)
            Divider()
            ContentUnavailableView("Different unavailable state", systemImage: "bubble.left.and.text.bubble.right")
        })
        let differentText = try labels(different).joined(separator: "\n")
        XCTAssertTrue(differentText.contains("Different unavailable state"), differentText)
        XCTAssertFalse(differentText.contains("No conversation selected"), differentText)

        let headerOnly = try await hostView(VStack {
            Text("Muster").font(.caption2)
            Text("Owned canvas control").font(.headline)
            Spacer()
        })
        let headerText = try labels(headerOnly).joined(separator: "\n")
        XCTAssertTrue(headerText.contains("Owned canvas control"), headerText)
        XCTAssertFalse(headerText.contains("No conversation selected"), headerText)
    }
}
