import Foundation

public struct CallCalendarEnrollment: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case waiting, approving, ready, consumed, cancelled, expired }
    public let id: String
    public let code: String?
    public let state: State
    public let expiresAt: Double
    public let botId: String
    public let threadId: String
    public let callId: String
}
public struct CallCalendarIssued: Codable, Equatable, Sendable {
    public struct Grant: Codable, Equatable, Sendable {
        public let id: String
        public let label: String
        public let calendarId: String
        public let expiresAt: Double
    }
    public let token: String
    public let grant: Grant
    public var isUsable: Bool { Self.validToken(token) && grant.expiresAt > Date().timeIntervalSince1970 * 1000 }
    static func validToken(_ token: String) -> Bool {
        token.utf8.count == 64 && token.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}
public struct CallCalendarEnrollmentReceipt: Codable, Equatable, Sendable {
    public let enrollment: CallCalendarEnrollment
    public let issued: CallCalendarIssued?
}
public struct CallCalendarScope: Equatable, Sendable {
    public let botId: String
    public let threadId: String
    public let callId: String
    public let capability: String
    public init(botId: String, threadId: String, callId: String, capability: String) {
        self.botId = botId; self.threadId = threadId; self.callId = callId; self.capability = capability
    }
}
public protocol CallCalendarTransport: Sendable {
    func beginCalendarEnrollment(botId: String, callId: String, capability: String, requestId: String) async throws -> CallCalendarEnrollmentReceipt
    func checkCalendarEnrollment(botId: String, callId: String, capability: String, enrollmentId: String) async throws -> CallCalendarEnrollmentReceipt
    func cancelCalendarEnrollment(botId: String, callId: String, capability: String, enrollmentId: String) async throws
    func prepareCallCalendarPlan(botId: String, callId: String, capability: String, calendarCapability: String, input: CallCalendarPlanRequest) async throws -> CallCalendarPlanDraft
}
extension CompanionClient: CallCalendarTransport {}

/// No automatic reads, retries, or model dispatch. A lost consumption receipt
/// requires a new enrollment. Changing context invalidates every pending result.
@MainActor public final class CallCalendarCoordinator {
    public private(set) var enrollment: CallCalendarEnrollment?
    public private(set) var code: String?
    public private(set) var issued: CallCalendarIssued?
    public private(set) var busy = false
    public private(set) var notice: String?
    private var scope: CallCalendarScope?
    private var transport: (any CallCalendarTransport)?
    private var generation = 0
    private var save: ((CallCalendarIssued) throws -> Void)?
    private let changed: () -> Void
    public init(changed: @escaping () -> Void = {}) { self.changed = changed }
    public func bind(scope: CallCalendarScope, transport: any CallCalendarTransport, issued: CallCalendarIssued?, save: @escaping (CallCalendarIssued) throws -> Void) {
        reset()
        self.scope = scope; self.transport = transport; self.issued = issued?.isUsable == true ? issued : nil; self.save = save
        changed()
    }
    public func reset() {
        if let enrollment, [.waiting, .approving, .ready].contains(enrollment.state), let scope, let transport {
            Task { _ = try? await transport.cancelCalendarEnrollment(botId: scope.botId, callId: scope.callId, capability: scope.capability, enrollmentId: enrollment.id) }
        }
        generation += 1; scope = nil; transport = nil; save = nil
        enrollment = nil; code = nil; issued = nil; busy = false; notice = nil; changed()
    }
    public func start() async {
        guard !busy, let scope, let transport else { return }
        // Reserve before awaiting cancellation: a second tap cannot create a
        // competing enrollment, and reset/cancel invalidates this reservation.
        let old = enrollment
        generation += 1; let stamp = generation
        busy = true; notice = nil; code = nil; enrollment = nil; changed()
        if let old, [.waiting, .approving, .ready].contains(old.state) {
            _ = try? await transport.cancelCalendarEnrollment(botId: scope.botId, callId: scope.callId, capability: scope.capability, enrollmentId: old.id)
            guard stamp == generation else { return }
        }
        let requestId = UUID().uuidString
        do {
            let receipt = try await transport.beginCalendarEnrollment(botId: scope.botId, callId: scope.callId, capability: scope.capability, requestId: requestId)
            guard stamp == generation else {
                _ = try? await transport.cancelCalendarEnrollment(botId: scope.botId, callId: scope.callId, capability: scope.capability, enrollmentId: receipt.enrollment.id)
                return
            }
            guard receipt.enrollment.id == requestId else { throw APIError.badURL }
            try apply(receipt, scope: scope, starting: true)
        } catch { if stamp == generation { notice = "Calendar connection was not confirmed. Start a new connection." } }
        if stamp == generation { busy = false; changed() }
    }
    public func check() async {
        guard !busy, let scope, let transport, let enrollment, [.waiting, .approving, .ready].contains(enrollment.state) else { return }
        let stamp = generation; busy = true; notice = nil; changed()
        do {
            let receipt = try await transport.checkCalendarEnrollment(botId: scope.botId, callId: scope.callId, capability: scope.capability, enrollmentId: enrollment.id)
            guard stamp == generation else { return }
            guard receipt.enrollment.id == enrollment.id else { throw APIError.badURL }
            try apply(receipt, scope: scope, starting: false)
        } catch {
            if stamp == generation {
                self.enrollment = nil; code = nil
                notice = "Approval receipt was not confirmed. Connect Calendar again; approval is never replayed."
            }
        }
        if stamp == generation { busy = false; changed() }
    }
    public func cancel() async {
        guard let scope, let transport else { return }
        let old = enrollment
        generation += 1; let stamp = generation
        enrollment = nil; code = nil; busy = false; notice = nil; changed()
        if let old {
            _ = try? await transport.cancelCalendarEnrollment(botId: scope.botId, callId: scope.callId, capability: scope.capability, enrollmentId: old.id)
        }
        if stamp == generation { changed() }
    }
    public func prepare(_ input: CallCalendarPlanRequest) async -> CallCalendarPlanDraft? {
        guard !busy, let scope, let transport, let issued, issued.isUsable else {
            notice = "Connect Calendar before preparing a draft."; changed(); return nil
        }
        let stamp = generation; busy = true; notice = nil; changed()
        defer { if stamp == generation { busy = false; changed() } }
        do {
            let draft = try await transport.prepareCallCalendarPlan(botId: scope.botId, callId: scope.callId, capability: scope.capability, calendarCapability: issued.token, input: input)
            guard stamp == generation else { return nil }
            guard draft.calendarId == issued.grant.calendarId, draft.date == input.date, draft.timeZone == input.timeZone,
                  !draft.draft.isEmpty, draft.draft.utf16.count <= 8000 else {
                notice = "This proposal cannot fit the call. Shorten the priorities or choose a quieter date."; return nil
            }
            return draft
        } catch {
            if stamp == generation { notice = "Calendar preparation failed. Check the connection and your planning inputs before trying again." }
            return nil
        }
    }
    private func apply(_ receipt: CallCalendarEnrollmentReceipt, scope: CallCalendarScope, starting: Bool) throws {
        let item = receipt.enrollment
        guard UUID(uuidString: item.id) != nil, item.botId == scope.botId, item.threadId == scope.threadId, item.callId == scope.callId else { throw APIError.badURL }
        if starting {
            guard item.state == .waiting, item.expiresAt.isFinite, item.expiresAt > Date().timeIntervalSince1970 * 1000,
                  let code = item.code, code.count == 8,
                  code.allSatisfy({ "0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains($0) }), receipt.issued == nil else { throw APIError.badURL }
            self.code = code
        }
        if let issued = receipt.issued {
            guard item.state == .consumed, issued.isUsable, !issued.grant.calendarId.isEmpty, let save else { throw APIError.badURL }
            try save(issued); self.issued = issued; code = nil
        } else if item.state == .consumed {
            self.enrollment = nil; code = nil
            notice = "Approval was already consumed. Connect Calendar again."; return
        }
        enrollment = item
        if [.cancelled, .expired].contains(item.state) { code = nil; notice = "Calendar connection expired or was cancelled. Connect again." }
    }
}
