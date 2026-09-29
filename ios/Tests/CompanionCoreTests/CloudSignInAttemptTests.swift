import Foundation
import XCTest
@testable import CompanionCore

final class CloudSignInAttemptTests: XCTestCase {
    private let code = String(repeating: "c", count: 43)
    private func callback(_ proof: CloudSignInAttempt.Proof, code: String? = nil) throws -> URL {
        try XCTUnwrap(URL(string: "muster://oauth/finish#code=\(code ?? self.code)&state=\(proof.state)&v=1"))
    }
    private func claimed(_ attempt: inout CloudSignInAttempt, _ proof: CloudSignInAttempt.Proof) throws -> CloudSignInAttempt.Exchange {
        guard case let .exchange(exchange) = attempt.claim(try callback(proof)) else {
            XCTFail("A matching active callback must start one exchange")
            throw NSError(domain: "CloudSignInAttemptTests", code: 1)
        }
        return exchange
    }

    func testRFC7636S256Vector() {
        XCTAssertEqual(CloudSignInAttempt.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
                       "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }
    func testFreshProofsHaveIndependentURLSafeEntropyAndExposeOnlyChallenge() throws {
        var attempt = CloudSignInAttempt()
        let first = try attempt.begin()
        let second = try attempt.begin()
        XCTAssertNotEqual(first.id, second.id)
        XCTAssertNotEqual(first.state, second.state)
        XCTAssertNotEqual(first.verifier, second.verifier)
        XCTAssertNotEqual(second.state, second.verifier)
        for token in [first.state, first.verifier, second.state, second.verifier, second.challenge] {
            XCTAssertEqual(token.count, 43)
            XCTAssertNotNil(token.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression))
        }
        XCTAssertEqual(Dictionary(uniqueKeysWithValues: second.queryItems.map { ($0.name, $0.value!) }),
                       ["state": second.state, "code_challenge": second.challenge, "code_challenge_method": "S256"])
        XCTAssertFalse(second.queryItems.contains { $0.value == second.verifier })
    }
    func testIdleAppRefusesAnOtherwiseValidExternalCallback() throws {
        var origin = CloudSignInAttempt()
        let proof = try origin.begin()
        var idle = CloudSignInAttempt()
        XCTAssertEqual(idle.claim(try callback(proof)), .rejected)
        XCTAssertNil(idle.activeID)
        XCTAssertFalse(idle.isExchanging)
    }
    func testMatchingCallbackCarriesOnlyItsOwnVerifierToOneExchange() throws {
        var attempt = CloudSignInAttempt()
        let proof = try attempt.begin()
        let exchange = try claimed(&attempt, proof)
        XCTAssertEqual(exchange.attemptID, proof.id)
        XCTAssertEqual(exchange.code, code)
        XCTAssertEqual(exchange.verifier, proof.verifier)
        XCTAssertTrue(attempt.isExchanging)
        XCTAssertTrue(attempt.finish(exchange))
        XCTAssertNil(attempt.activeID)
    }
    func testRejectsMissingWrongDuplicateOrAmbiguousBindingWithoutCancelingTheActiveAttempt() throws {
        var attempt = CloudSignInAttempt()
        let proof = try attempt.begin()
        for fragment in [
            "code=\(code)", "code=\(code)&v=1", "code=\(code)&state=wrong&v=1",
            "code=\(code)&state=\(proof.state)", "code=\(code)&state=\(proof.state)&v=2",
            "code=\(code)&state=\(proof.state)&v=01", "code=\(code)&state=\(proof.state)&v=1&v=1",
            "code=\(code)&state=\(proof.state)&v=1&%73tate=wrong",
            "code=\(code)&state=\(proof.state)&v=1&code=\(code)",
            "code=short&state=\(proof.state)&v=1", "code=\(String(repeating: "c", count: 42))%0A&state=\(proof.state)&v=1",
            "code=\(code)&state=\(proof.state)&v=1&", String(repeating: "x", count: 2049),
        ] {
            XCTAssertEqual(attempt.claim(try XCTUnwrap(URL(string: "muster://oauth/finish#\(fragment)"))), .rejected)
            XCTAssertEqual(attempt.activeID, proof.id)
            XCTAssertFalse(attempt.isExchanging)
        }
        _ = try claimed(&attempt, proof)
    }
    func testRequiresExactCallbackEndpointWithoutUserinfoPortQueryOrEncodedPath() throws {
        var attempt = CloudSignInAttempt()
        let proof = try attempt.begin()
        for base in ["muster://oauth", "muster://oauth/finish/extra", "muster://oauth/%66inish",
                     "muster://user@oauth/finish", "muster://oauth:443/finish", "muster://oauth/finish?code=elsewhere",
                     "https://oauth/finish", "muster://other/finish", "muster://oauth/finish/"] {
            let url = try XCTUnwrap(URL(string: "\(base)#code=\(code)&state=\(proof.state)&v=1"))
            XCTAssertEqual(attempt.claim(url), .unrelated, base)
        }
        XCTAssertEqual(attempt.activeID, proof.id)
        XCTAssertFalse(attempt.isExchanging)
    }
    func testDualPlatformDeliveryExchangesOnlyOnceAndCannotReplayAfterCompletion() throws {
        var attempt = CloudSignInAttempt()
        let proof = try attempt.begin()
        let exchange = try claimed(&attempt, proof)
        XCTAssertEqual(attempt.claim(try callback(proof)), .duplicate)
        XCTAssertTrue(attempt.finish(exchange))
        XCTAssertFalse(attempt.finish(exchange))
        XCTAssertEqual(attempt.claim(try callback(proof)), .rejected)
    }
    func testCancelOrSignOutAfterClaimPreventsLateIdentityOrFailureApplication() throws {
        var attempt = CloudSignInAttempt()
        let proof = try attempt.begin()
        let exchange = try claimed(&attempt, proof)
        XCTAssertTrue(attempt.cancel())
        // The app applies either identity or error only after finish succeeds.
        XCTAssertFalse(attempt.finish(exchange))
        XCTAssertFalse(attempt.finish(exchange))
        XCTAssertEqual(attempt.claim(try callback(proof)), .rejected)
        XCTAssertNil(attempt.activeID)
    }
    func testSupersededInFlightReplyCannotSettleTheNewAttempt() throws {
        var attempt = CloudSignInAttempt()
        let old = try attempt.begin()
        let oldExchange = try claimed(&attempt, old)
        let current = try attempt.begin()
        XCTAssertFalse(attempt.finish(oldExchange))
        XCTAssertEqual(attempt.claim(try callback(old)), .rejected)
        XCTAssertEqual(attempt.activeID, current.id)
        XCTAssertFalse(attempt.isExchanging)
        let currentExchange = try claimed(&attempt, current)
        XCTAssertFalse(attempt.finish(oldExchange))
        XCTAssertTrue(attempt.finish(currentExchange))
    }
    func testLateBrowserCancellationDoesNotCancelTheReplacementAttempt() throws {
        var attempt = CloudSignInAttempt()
        let old = try attempt.begin()
        let current = try attempt.begin()
        XCTAssertFalse(attempt.cancel(old.id))
        XCTAssertEqual(attempt.activeID, current.id)
        XCTAssertTrue(attempt.cancel(current.id))
        XCTAssertNil(attempt.activeID)
    }
    func testDifferentCodeCannotReplaceTheClaimedCode() throws {
        var attempt = CloudSignInAttempt()
        let proof = try attempt.begin()
        let exchange = try claimed(&attempt, proof)
        XCTAssertEqual(attempt.claim(try callback(proof, code: String(repeating: "d", count: 43))), .rejected)
        XCTAssertTrue(attempt.finish(exchange))
    }
    func testIndependentDevicesCannotBorrowEachOthersAttempt() throws {
        var first = CloudSignInAttempt()
        var second = CloudSignInAttempt()
        let firstProof = try first.begin()
        let secondProof = try second.begin()
        XCTAssertEqual(second.claim(try callback(firstProof)), .rejected)
        XCTAssertEqual(first.claim(try callback(secondProof)), .rejected)
        let firstExchange = try claimed(&first, firstProof)
        XCTAssertFalse(second.finish(firstExchange))
        XCTAssertEqual(second.activeID, secondProof.id)
    }
}
