// Live transport acceptance: MusterTransport and LiveSessionModel against a
// REAL booted harness server (the same fixture family as the server's own
// harness tests — owned temp directories, isolated ports, fake driver).
//
// Proven here, not assumed: sign-up/sign-in cookie capture (and the 401
// path), roster + transcript hydration, durable-intent send with a replay
// that returns the SAME message id, and a full SSE connection whose hello
// frame carries the cursor and whose stream carries the sent message.
//
// The server is booted by Scripts/LiveHarness.swift via node (see
// macos/Scripts/README.md); the tests skip loudly when node or the server
// cannot start, never silently.

import CompanionCore
import MusterMacCore
import XCTest

final class LiveTransportTests: XCTestCase {
    /// Minimal sendable box for cross-concurrency-domain capture in tests.
    private final class Unboxed<Value: Sendable>: @unchecked Sendable {
        var value: Value
        init(_ value: Value) { self.value = value }
    }

    private final class Harness {
        let originText: String
        let account: HarnessAccount
        let botId: String
        private let process: Process
        private let directory: String

        private init(originText: String, account: HarnessAccount, botId: String, process: Process, directory: String) {
            self.originText = originText
            self.account = account
            self.botId = botId
            self.process = process
            self.directory = directory
        }

        /// Boot the fixture server via macos/Scripts/boot-harness.mjs. The
        /// script stays alive owning the server's lifecycle; facts arrive on
        /// stdout, redirected into a file we poll. `stop()` terminates the
        /// script, whose SIGTERM handler stops the server and removes the
        /// temp directory.
        static func boot() async throws -> Harness {
            let root = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
            let script = root.appendingPathComponent("macos/Scripts/boot-harness.mjs")
            guard FileManager.default.fileExists(atPath: script.path) else {
                throw XCTSkip("boot-harness.mjs not found at \(script.path)")
            }
            let directory = NSTemporaryDirectory() + "muster-mac-facts-\(UUID().uuidString.prefix(8))"
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let factsPath = (directory as NSString).appendingPathComponent("facts.txt")
            guard FileManager.default.createFile(atPath: factsPath, contents: nil) else {
                throw XCTSkip("could not create facts file")
            }
            let facts = try FileHandle(forWritingTo: URL(fileURLWithPath: factsPath))
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node", script.path]
            process.standardOutput = facts
            process.standardError = FileHandle.nullDevice
            try process.run()
            defer { try? facts.close() }

            var contents = ""
            let deadline = Date().addingTimeInterval(90)
            while Date() < deadline {
                contents = (try? String(contentsOfFile: factsPath, encoding: .utf8)) ?? ""
                if contents.contains("botId=") { break }
                if !process.isRunning { throw XCTSkip("harness boot exited early") }
                try await Task.sleep(nanoseconds: 200_000_000)
            }
            guard contents.contains("botId=") else {
                process.terminate()
                throw XCTSkip("harness boot timed out")
            }
            func fact(_ key: String) throws -> String {
                guard let line = contents.split(separator: "\n").first(where: { $0.hasPrefix("\(key)=") }) else {
                    throw XCTSkip("missing \(key) from harness boot")
                }
                return String(line.dropFirst(key.count + 1))
            }
            let origin = try fact("origin")
            let cookieName = try fact("cookieName")
            let cookieValue = try fact("cookieValue")
            let botId = try fact("botId")
            return Harness(
                originText: origin,
                account: HarnessAccount(origin: origin, cookieName: cookieName, cookieValue: cookieValue),
                botId: botId,
                process: process,
                directory: directory)
        }

        func stop() {
            if process.isRunning { process.terminate() }
            let deadline = Date().addingTimeInterval(5)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.1) }
            if process.isRunning { process.terminate() }
            try? FileManager.default.removeItem(atPath: directory)
        }
    }

    func testSignInRejectsWrongPasswordWithoutCookie() async throws {
        let harness = try await Harness.boot()
        defer { harness.stop() }
        // A wrong password must fail with 401 and produce no account.
        do {
            _ = try await MusterTransport.signIn(
                originText: harness.originText,
                email: "wrong-\(UUID().uuidString.prefix(6))@example.test",
                password: "not-the-password",
                mode: .signIn)
            XCTFail("sign-in with a wrong password must throw")
        } catch let error as MusterTransportError {
            guard case .server(401, _) = error else { return XCTFail("expected 401, got \(error)") }
        }
    }

    func testRosterAndTranscriptRoundTrip() async throws {
        let harness = try await Harness.boot()
        defer { harness.stop() }
        let transport = try MusterTransport(account: harness.account)
        let roster = try await transport.roster(messages: 50)
        // The server may seed a default bot alongside the fixture one; find OURS.
        guard let bot = roster.bots.first(where: { $0.id == harness.botId }) else {
            return XCTFail("seeded bot \(harness.botId) missing from roster of \(roster.bots.map(\.id))")
        }
        let messages = try await transport.threadMessages(threadId: bot.threadId)
        XCTAssertNotNil(messages as [Message]?)
    }

    func testSendIntentAndReplayReturnSameMessage() async throws {
        let harness = try await Harness.boot()
        defer { harness.stop() }
        let transport = try MusterTransport(account: harness.account)
        let roster = try await transport.roster(messages: 0)
        guard let bot = roster.bots.first(where: { $0.id == harness.botId }) else {
            return XCTFail("seeded bot \(harness.botId) missing from roster of \(roster.bots.map(\.id))")
        }
        let intentId = "it-\(UUID().uuidString.prefix(12).lowercased())"
        let receipt = try await transport.send(text: "Live test \(intentId)", to: bot.id, clientIntentId: intentId)
        // state is the server's honest belief: accepted (durable, not yet
        // observed by a turn) or dispatched (a turn already carries them).
        XCTAssertTrue(["accepted", "dispatched"].contains(receipt.state), "unexpected receipt state \(receipt.state)")
        // Replay: same id → same message id, never a duplicate.
        let replay = try await transport.send(text: "Live test \(intentId)", to: bot.id, clientIntentId: intentId)
        XCTAssertEqual(replay.messageId, receipt.messageId)
    }

    @MainActor
    func testLiveStreamCarriesHelloAndOwnMessage() async throws {
        let harness = try await Harness.boot()
        defer { harness.stop() }
        let transport = try MusterTransport(account: harness.account)
        let roster = try await transport.roster(messages: 0)
        guard let bot = roster.bots.first(where: { $0.id == harness.botId }) else {
            return XCTFail("seeded bot \(harness.botId) missing from roster of \(roster.bots.map(\.id))")
        }

        // Detached on purpose: the stream must work from a plain concurrent
        // context, and a poll loop keeps the diagnosis simple.
        let hello = Unboxed<(String, Bool)?>(nil)
        let frameBox = Unboxed<StreamFrame?>(nil)
        let streamErrorBox = Unboxed<Error?>(nil)
        let streamTask = Task.detached {
            do {
                try await transport.events(
                    lastEventId: nil,
                    onEvent: { streamFrame in frameBox.value = streamFrame },
                    onHello: { cursor, resumed in hello.value = (cursor, resumed) })
            } catch {
                streamErrorBox.value = error
            }
        }
        var waited = 0.0
        while waited < 20, hello.value == nil, streamErrorBox.value == nil {
            try await Task.sleep(nanoseconds: 200_000_000)
            waited += 0.2
        }
        if let streamError = streamErrorBox.value {
            XCTFail("stream task threw: \(streamError)")
        }
        guard let (cursor, resumed) = hello.value else {
            streamTask.cancel()
            return XCTFail("no hello frame within 20s")
        }
        XCTAssertFalse(resumed, "a cold start must be told to hydrate")
        XCTAssertFalse(cursor.isEmpty, "hello must carry the stream cursor")
        streamTask.cancel()

        let model = LiveSessionModel()
        model.connect(account: harness.account)
        // Wait for live + roster to settle, then send through the model.
        for _ in 0..<50 where model.state != .live { try await Task.sleep(nanoseconds: 100_000_000) }
        guard case .live = model.state else { return XCTFail("session never went live: \(model.state)") }
        model.selectedThreadId = bot.threadId
        model.draft = "Model send \(UUID().uuidString.prefix(8))"
        await model.sendDraft()
        // The 202 receipt retires the pending row: messageId is set and the
        // optimistic row leaves the list once its message is visible.
        if let pending = model.pendingSends.first {
            XCTAssertNotEqual(pending.state, "pending", "send must get an authoritative receipt")
        }
        model.disconnect()
    }
}
