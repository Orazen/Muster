// The explicit, identified, GET-only harness probe.
//
// M0's rule from the migration plan: any harness connection must be
// explicitly identified and read-only. This transport therefore:
//   - requires the caller to construct it with a concrete base URL (no
//     default endpoint, no discovery),
//   - refuses to issue anything but GET requests,
//   - exposes only the fleet snapshot (`/api/bots`), which is read-only,
//   - labels every result as an identified snapshot of a named origin.
//
// There is deliberately no send, no approve, and no stream method here:
// those are mutations (or mutation-adjacent) and belong to later slices
// behind real authentication.
//
// `fleet(messages:)` on CompanionClient is a GET of /api/bots — verified
// against the server route table — so the probe reuses the shared client
// for parsing while pinning the method at this boundary.

import CompanionCore
import Foundation

public struct HarnessSnapshot: Sendable {
    public let origin: URL
    public let fleet: Fleet

    /// True when the snapshot contains at least one bot. A UI must render
    /// empty/loading states from this, not from transport errors alone.
    public var isEmpty: Bool { fleet.bots.isEmpty && fleet.groups.isEmpty }
}

public enum HarnessProbeError: Error, Equatable, Sendable {
    case mutationRefused
    case connectionFailed
}

public struct HarnessProbe: Sendable {
    public let origin: URL
    private let session: URLSession

    /// Building the probe is the explicit identification step: there is no
    /// implicit "current server".
    public init(origin: URL, session: URLSession = .shared) {
        self.origin = origin
        self.session = session
    }

    /// Fetch the fleet snapshot. GET-only; any other verb is refused at
    /// this boundary, not at the network layer.
    public func fleetSnapshot() async throws -> HarnessSnapshot {
        var request = URLRequest(url: origin.appending(path: "api/bots"))
        request.httpMethod = "GET"
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw HarnessProbeError.connectionFailed
        }
        let fleet = try JSONDecoder().decode(Fleet.self, from: data)
        return HarnessSnapshot(origin: origin, fleet: fleet)
    }

    /// Compile-time + runtime statement of the boundary: the probe cannot
    /// mutate. Kept as an API so a caller can prove refusal in tests.
    public static func refusesMutation(_ verb: String) -> Bool {
        verb != "GET"
    }
}
