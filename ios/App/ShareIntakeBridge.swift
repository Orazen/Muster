// ShareIntakeBridge — the other half of inbound share intake.
//
// The share extension is a separate process. It cannot hand text to this app
// in memory, so it writes one small JSON bundle into the shared app group and
// the app reads it on the next foreground. This file is the reader.
//
// It is deliberately only a reader. Every accept-or-refuse decision lives in
// CompanionCore (`ShareIntake`/`ShareStaging`) and is covered by `swift test`;
// what is left here is file handling, which needs a real container and a
// second process to mean anything and so cannot be unit tested.
//
// A bundle is deleted once read, whatever the intake decided. If the app dies
// between staging and deleting, the file survives and the next launch reads it
// again — the intake's consumed-id fence catches that within a session. Across
// a re-pair the fence is gone, so a crash-window share can be staged a second
// time on the new pairing. That costs at most one duplicate *draft*, still
// behind a human Send, which is a very different thing from a duplicated
// message.
import Foundation
import OSLog
import CompanionCore

@MainActor
final class ShareIntakeBridge {
    static let shared = ShareIntakeBridge()
    private let log = Logger(subsystem: "com.muster.companion", category: "share")
    private init() {}

    /// Where the extension stages bundles. Nil when the group entitlement is
    /// missing or the container cannot be opened — a personal-team build
    /// without the group, or a simulator that never created it. Share intake
    /// then simply does not exist, and nothing else is affected.
    private var stagingDirectory: URL? {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: FleetSnapshotStore.appGroupId) else { return nil }
        let directory = container.appendingPathComponent(ShareStaging.directoryName, isDirectory: true)
        if !FileManager.default.fileExists(atPath: directory.path) {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        return directory
    }

    /// Read every staged bundle, oldest id first, into `intake`. Returns how
    /// many were newly staged, so a caller can decide whether anything
    /// changed.
    @discardableResult
    func adoptStagedShares(into intake: ShareIntake) -> Int {
        guard intake.isPaired, let directory = stagingDirectory else { return 0 }
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        // Anything that is not exactly a staged-bundle name is not ours. The
        // shared container also holds the fleet snapshot, and this is the only
        // thing in it this file may touch.
        let bundles = names.compactMap { name -> (UUID, URL)? in
            guard let id = ShareStaging.stagedId(inFilename: name) else { return nil }
            return (id, directory.appendingPathComponent(name))
        }.sorted { $0.0.uuidString < $1.0.uuidString }
        // The filename is only a claim; the id inside the bundle is the
        // authority, and it is what fences a re-read. A file whose inner id
        // disagrees with its own name is malformed, not merely unusual.
        // (Verified by ShareStagingTests: the two must agree.)

        var staged = 0
        for (_, url) in bundles {
            // Read and delete under one coordination, so an extension writing
            // the same name at the same moment cannot be half-read. If
            // coordination itself fails the file is left alone and read again
            // next foreground — nothing is lost by waiting, because the
            // bundle is still on disk.
            var coordinationFailure: NSError?
            NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationFailure) { readURL in
                guard let data = try? Data(contentsOf: readURL) else { return }
                // The id inside the bundle is the authority; the filename only
                // got us here. A file whose inner id disagrees with its own
                // name is malformed, not merely unusual, and is not trusted
                // enough to become a draft.
                guard let share = ShareStaging.decode(data), share.id == ShareStaging.stagedId(inFilename: readURL.lastPathComponent) else {
                    log.error("discarded a malformed share bundle")
                    try? FileManager.default.removeItem(at: readURL)
                    return
                }
                switch intake.receive(ShareStaging.payload(share), receivedAt: share.receivedAt, id: share.id) {
                case .success:
                    staged += 1
                case .failure(let rejection):
                    // `.alreadyStaged` is the normal re-read after a crash
                    // between staging and deleting, and needs no log line. The
                    // others are worth the owner's attention, so they become a
                    // notice they can read.
                    if case .alreadyStaged = rejection { break }
                    log.error("shared text refused: \(rejection.reason, privacy: .public)")
                    intake.report(rejection)
                }
                try? FileManager.default.removeItem(at: readURL)
            }
            if coordinationFailure != nil {
                log.error("could not coordinate reading a share bundle")
            }
        }
        return staged
    }
}
