// The share extension: the door that lets text into Muster from another app.
//
// There was no inbound path at all before this — the app could hand a file
// *out* through UIActivityViewController, but nothing could bring text in.
// This is the smallest thing that fixes that.
//
// It is a separate process, so it cannot call the app. It writes one small
// JSON bundle into the shared app group and completes; the app collects it on
// the next foreground (`ShareIntakeBridge`) and stages it (`ShareIntake`).
// Every accept-or-refuse decision lives in CompanionCore and is covered by
// `swift test` — this file only unwraps UIKit item providers.
//
// What it deliberately does NOT do:
//  - send anything. Not even "obviously safe" text. The app stages the words
//    into a composer and the owner presses Send, because a message in a bot's
//    thread is an instruction the bot will act on, and text from another app
//    has not been read by anyone.
//  - guess at non-text. A photo or a spreadsheet has no destination in Muster,
//    and picking something plausible for it is how a share becomes a surprise.
import UIKit
import UniformTypeIdentifiers
import CompanionCore

final class ShareViewController: UIViewController {
    /// Text-ish types, in the order they are tried. Plain text first because
    /// that is what "Copy" and a selected paragraph produce; `text` catches
    /// RTF and HTML, which the strict UTF-8 check in the core rejects if they
    /// are not actually text.
    private static let textTypes = [UTType.plainText, UTType.utf8PlainText, UTType.text, UTType.html]
    /// A link is accepted, but only as its textual form. The app has no
    /// importer, so the document a URL points at is not fetched or read.
    private static let linkTypes = [UTType.url, UTType.fileURL]

    override func viewDidLoad() {
        super.viewDidLoad()
        // No UI: a share extension that shows its own interface has to be
        // dismissed again, and this one has nothing to ask. Completing is what
        // closes the sheet; the words are waiting in the app.
        view.backgroundColor = .clear
        view.isHidden = true
        Task { await collect() }
    }

    private func collect() async {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        var declaredText = false
        var declaredLink = false
        var candidates: [Data] = []

        for item in items {
            for provider in item.attachments ?? [] {
                for type in Self.textTypes where provider.hasItemConformingToTypeIdentifier(type.identifier) {
                    declaredText = true
                    candidates.append(contentsOf: await load(from: provider, as: type))
                }
                for type in Self.linkTypes where provider.hasItemConformingToTypeIdentifier(type.identifier) {
                    declaredLink = true
                    if let url = await loadURL(from: provider, as: type) {
                        candidates.append(Data(url.absoluteString.utf8))
                    }
                }
                if candidates.count >= ShareStaging.maximumCandidates { break }
            }
            if candidates.count >= ShareStaging.maximumCandidates { break }
        }

        // Nothing textual was offered. Completing without staging is correct:
        // the alternative is an error the person cannot act on, and this
        // extension's activation rule already limits what iOS offers it.
        guard declaredText || declaredLink else { return complete() }
        let share = StagedShare(id: UUID(), declaredText: declaredText, declaredLink: declaredLink,
                                receivedAt: Date(),
                                candidates: Array(candidates.prefix(ShareStaging.maximumCandidates)))
        guard let data = ShareStaging.encode(share) else { return complete() }
        await write(data, id: share.id)
        complete()
    }

    /// `loadItem` hands back a String, Data or URL depending on what the
    /// sending app put in, so every shape is flattened to bytes here and
    /// judged in CompanionCore. A provider that loads nothing simply
    /// contributes no candidate, which reads as an empty share later.
    private func load(from provider: NSItemProvider, as type: UTType) async -> [Data] {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { value, _ in
                switch value {
                case let data as Data: continuation.resume(returning: [data])
                case let text as String: continuation.resume(returning: [Data(text.utf8)])
                case let url as URL: continuation.resume(returning: [Data(url.absoluteString.utf8)])
                default: continuation.resume(returning: [])
                }
            }
        }
    }

    private func loadURL(from provider: NSItemProvider, as type: UTType) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { value, _ in
                if let url = value as? URL {
                    continuation.resume(returning: url)
                } else if let text = value as? String {
                    continuation.resume(returning: URL(string: text))
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    /// Same directory and filename rule the app reads, both from CompanionCore
    /// so the two processes cannot disagree about either.
    private func write(_ data: Data, id: UUID) async {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: FleetSnapshotStore.appGroupId) else { return }
        let directory = container.appendingPathComponent(ShareStaging.directoryName, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: directory.appendingPathComponent(ShareStaging.filename(for: id)), options: .atomic)
        } catch {
            // A share that cannot be staged is simply not shared. Completing
            // anyway is right: the alternative is an error sheet the person
            // cannot act on.
        }
    }

    private func complete() {
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
}
