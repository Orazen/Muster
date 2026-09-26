// WatchHandoffOrdering — deciding WHICH pairing delivery the watch believes.
//
// The bug this exists to fix. The phone ships each pairing over two
// WatchConnectivity channels: `updateApplicationContext` (latest-wins) and
// `transferUserInfo` (queued, FIFO, delivered whenever the wrist next wakes).
// Both carry the same payload. So a payload can arrive long after a newer one:
// the watch used to accept any delivery that was not byte-identical to what it
// already held, which meant a queued OLD pairing could replace a CURRENT one —
// putting a revoked computer's token back into the keychain — and a queued OLD
// unpair could sign the watch out of a pairing that was created after it.
//
// `sentAt` was already on the payload and was never read. A wall clock is the
// wrong ordering key anyway: it is the SENDER's clock, two phones disagree, and
// a backwards clock step reorders history. So the phone assigns a monotonic
// GENERATION to every pairing event, pairs and unpairs alike, and the watch
// keeps the highest generation it has ever seen. Higher wins; equal is the
// idempotent no-op; lower is stale and is dropped.
//
// The generation is PERSISTED, and that is the half that matters after a
// restart: the queued transfers outlive the process, so a watch that forgot its
// generation on launch would treat a week-old queued pairing as brand new and
// happily adopt it. A store that forgets is a store that revokes nothing.
//
// The reducer is pure and lives here, in the one target the test suite builds.
// `WatchHandoffReceiver` is a thin shell over it, because a WCSession delegate
// cannot be exercised without a paired radio — the decision is what can be
// pinned, so the decision is what carries the tests.
import Foundation

/// What the watch currently believes, and the highest generation it has seen.
public struct HandoffTrustState: Codable, Equatable, Sendable {
    /// The pairing in force, or nil when unpaired.
    public var connection: Connection?
    /// The token belonging to `connection`, held so a duplicate can be told
    /// from a re-pair without touching the keychain on the hot path.
    public var token: String?
    /// Highest generation ever observed, paired or unpaired. Survives unpairing,
    /// which is what makes a delayed unpair droppable.
    public var generation: UInt64
    /// Monotonic floor handed out to the next local pairing event.
    public var counter: UInt64

    public init(connection: Connection? = nil, token: String? = nil, generation: UInt64 = 0, counter: UInt64 = 0) {
        self.connection = connection
        self.token = token
        self.generation = generation
        self.counter = counter
    }

    public var isPaired: Bool { connection != nil }
}

/// Where the generation survives process death. Injectable so the reducer is
/// testable without UserDefaults, and so a platform that wants a different
/// store can supply one.
public protocol HandoffTrustStore: AnyObject {
    func load() -> HandoffTrustState
    func save(_ state: HandoffTrustState)
}

/// UserDefaults-backed store. One key, one small value, written on every change.
public final class UserDefaultsHandoffTrustStore: HandoffTrustStore {
    private let defaults: UserDefaults
    private let key: String

    public init(defaults: UserDefaults = .standard, key: String = "companion.handoff.trust") {
        self.defaults = defaults
        self.key = key
    }

    public func load() -> HandoffTrustState {
        guard let raw = defaults.data(forKey: key) else { return HandoffTrustState() }
        return (try? JSONDecoder().decode(HandoffTrustState.self, from: raw)) ?? HandoffTrustState()
    }

    public func save(_ state: HandoffTrustState) {
        guard let raw = try? JSONEncoder().encode(state) else { return }
        defaults.set(raw, forKey: key)
    }
}

/// What the watch should do about a delivery.
public enum HandoffDecision: Equatable, Sendable {
    /// Pair with this. The shell clears any previous pairing and adopts.
    case adopt(CompanionHandoff)
    /// Unpair. The shell signs out.
    case unpair(generation: UInt64)
    /// Already believed; nothing to do. A redelivery, not a change.
    case duplicate
    /// Older than what the watch already holds. Dropped, and deliberately
    /// NOT acted on: this is the case that used to restore revoked trust.
    case stale
}

public struct WatchHandoffOrdering {
    private let store: HandoffTrustStore

    public init(store: HandoffTrustStore) {
        self.store = store
    }

    /// The phone's side of the counter: the next generation for a local event.
    /// Shared so the phone never issues the same generation twice.
    ///
    /// The floor is `max(counter, generation)`, not `counter`. A restore, or a
    /// watch that adopted a high generation over the wire, can know a number it
    /// never issued itself — counting from its own zero would reissue a
    /// generation that already means something, and two different pairings
    /// would compare equal.
    public static func nextGeneration(_ state: HandoffTrustState) -> (generation: UInt64, state: HandoffTrustState) {
        let next = max(state.counter, state.generation) + 1
        var updated = state
        updated.counter = next
        updated.generation = max(updated.generation, next)
        return (next, updated)
    }

    public func currentState() -> HandoffTrustState { store.load() }

    /// A pairing the phone is delivering. `sentAt` is deliberately ignored —
    /// see the header on why a sender clock cannot order these.
    public func decidePairing(_ handoff: CompanionHandoff) -> HandoffDecision {
        let state = store.load()
        let generation = handoff.generation

        // No generation at all is an older phone that never learned to number
        // its events. Its delivery is still honoured when the watch holds
        // nothing, and dropped once it does, which is the conservative reading:
        // an unnumbered pairing cannot be shown to be newer than a numbered one.
        if let generation, generation < state.generation { return .stale }
        if generation == nil && state.generation > 0 { return .stale }

        if state.connection?.id == handoff.connection.id, state.token == handoff.token {
            // Same pairing, same token. Advance the floor so a later unnumbered
            // delivery is still correctly seen as stale, then no-op.
            if let generation, generation > state.generation {
                var advanced = state
                advanced.generation = generation
                store.save(advanced)
            }
            return .duplicate
        }
        return .adopt(handoff)
    }

    /// An unpair tombstone. `generation` is nil for the 1.20 bare-string
    /// marker, which carries no ordering at all.
    public func decideUnpair(generation: UInt64?) -> HandoffDecision {
        let state = store.load()
        if let generation {
            // A delayed tombstone must not clear a pairing created after it.
            if generation < state.generation { return .stale }
            var updated = state
            updated.generation = max(updated.generation, generation)
            updated.connection = nil
            updated.token = nil
            store.save(updated)
            return .unpair(generation: generation)
        }
        // An unnumbered tombstone from an old phone: honour it, because
        // refusing would leave a watch paired to a phone that has moved on, and
        // an unpair is the safe direction to be wrong in.
        var updated = state
        updated.connection = nil
        updated.token = nil
        store.save(updated)
        return .unpair(generation: state.generation)
    }

    /// Commit an adopted pairing. Separate from `decidePairing` so the shell
    /// performs the keychain work first and only then advances the floor.
    public func commitAdoption(_ handoff: CompanionHandoff) {
        let state = store.load()
        var updated = state
        updated.connection = handoff.connection
        updated.token = handoff.token
        if let generation = handoff.generation {
            updated.generation = max(updated.generation, generation)
        }
        updated.counter = max(updated.counter, updated.generation)
        store.save(updated)
    }
}
