// Cloud identity for the companion — Google sign-in from the phone.
//
// The desktop solves "no client secret in the binary" with the cloud handoff:
// cloud /desktop-auth/start -> Google -> /desktop-auth/done -> one-time code
// bounced to a loopback redirect the desktop is listening on. A phone cannot
// host a loopback listener, so it registers the `muster` URL scheme and the
// cloud finishes into `muster://oauth/finish#code=…` instead (allowlisted
// exactly, server/desktop-auth.ts). The app catches that in onOpenURL or in
// the ASWebAuthenticationSession completion (iOS can deliver both), then
// exchanges the code against the cloud's /api/desktop-auth/exchange — the
// same endpoint the desktop's local server calls.
//
// What this buys, honestly: a verified cloud identity (email + name) shown
// in onboarding and settings. It does NOT pair the phone — pairing stays
// anchored to the computer's one-time credential, which is the actual trust
// root for the event stream. No token is stored, because none is issued.
import AuthenticationServices
import Foundation
import SwiftUI
import CompanionCore

struct CloudIdentity: Codable, Equatable {
    let email: String
    let name: String
}

@MainActor
final class CloudAuth: NSObject, ObservableObject {
    static let shared = CloudAuth()

    /// The production cloud. The handoff only exists there; local installs
    /// pair by credential and never need this.
    static let cloudBase = URL(string: "https://muster.today")!
    /// Exactly the URL server/desktop-auth.ts allowlists.
    static let callbackURL = URL(string: "muster://oauth/finish")!
    static let callbackScheme = "muster"
    private static let storeKey = "cloudIdentity.v1"

    @Published private(set) var identity: CloudIdentity?
    /// True while the ASWebAuthenticationSession sheet is up; guards the
    /// double-delivery path (completion handler + onOpenURL) from racing a
    /// single-use code.
    @Published private(set) var signingIn = false
    @Published var error: String?

    private var webSession: ASWebAuthenticationSession?
    private var attempt = CloudSignInAttempt()
    private var exchangeTask: Task<Void, Never>?

    private override init() {
        super.init()
        if let data = UserDefaults.standard.data(forKey: Self.storeKey),
           let decoded = try? JSONDecoder().decode(CloudIdentity.self, from: data) {
            identity = decoded
        }
    }

    var isSignedIn: Bool { identity != nil }

    private func store(_ newIdentity: CloudIdentity?) {
        identity = newIdentity
        let defaults = UserDefaults.standard
        if let newIdentity, let data = try? JSONEncoder().encode(newIdentity) {
            defaults.set(data, forKey: Self.storeKey)
        } else {
            defaults.removeObject(forKey: Self.storeKey)
        }
    }

    func signOut() {
        cancelSignIn()
        store(nil)
        error = nil
    }

    func cancelSignIn() {
        // Invalidate first: cancellation/completion handlers can arrive later.
        attempt.cancel()
        exchangeTask?.cancel()
        exchangeTask = nil
        webSession?.cancel()
        webSession = nil
        signingIn = false
    }

    /// Start a bound handoff from this device; the verifier never enters a URL.
    func startSignIn() {
        guard !signingIn else { return }
        cancelSignIn()
        error = nil
        let proof: CloudSignInAttempt.Proof
        do { proof = try attempt.begin() }
        catch { self.error = "Could not prepare sign-in. Try again."; return }
        var components = URLComponents(url: Self.cloudBase, resolvingAgainstBaseURL: false)!
        components.path = "/desktop-auth/start"
        components.queryItems = [URLQueryItem(name: "redirect", value: Self.callbackURL.absoluteString)] + proof.queryItems
        let session = ASWebAuthenticationSession(url: components.url!, callbackURLScheme: Self.callbackScheme) { [weak self] callback, err in
            Task { @MainActor in
                guard let self, self.attempt.activeID == proof.id else { return }
                if let callback {
                    _ = self.handleCallback(callback)
                    // The sheet has finished. A malformed callback must not
                    // leave a pending attempt active indefinitely.
                    if !self.attempt.isExchanging, self.attempt.cancel(proof.id) {
                        self.signingIn = false
                        self.webSession = nil
                        self.error = "This sign-in could not be verified. Start again from Muster."
                    }
                } else if !self.attempt.isExchanging, self.attempt.cancel(proof.id) {
                    self.signingIn = false
                    self.webSession = nil
                    if let err, (err as? ASWebAuthenticationSessionError)?.code != .canceledLogin {
                        self.error = Self.friendly(err)
                    }
                }
            }
        }
        session.prefersEphemeralWebBrowserSession = true
        session.presentationContextProvider = self
        webSession = session
        signingIn = true
        guard session.start() else {
            cancelSignIn()
            error = "Could not open the sign-in window. Try again."
            return
        }
    }

    /// Both platform deliveries claim the same active local attempt. An idle,
    /// foreign, replayed or unbound callback cannot start a code exchange.
    @discardableResult
    func handleCallback(_ url: URL) -> Bool {
        switch attempt.claim(url) {
        case .unrelated: return false
        case .rejected, .duplicate: return true
        case let .exchange(exchange):
            signingIn = true
            // A resulting canceledLogin completion sees isExchanging and
            // cannot invalidate the already accepted callback.
            webSession?.cancel()
            webSession = nil
            exchangeTask = Task { [weak self] in await self?.exchange(exchange) }
            return true
        }
    }

    /// Exchange only with the fixed cloud endpoint, with no redirect replay.
    private func exchange(_ exchange: CloudSignInAttempt.Exchange) async {
        var components = URLComponents(url: Self.cloudBase, resolvingAgainstBaseURL: false)!
        components.path = "/api/desktop-auth/exchange"
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 20
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: CloudIdentityRedirectPolicy.shared, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: ["code": exchange.code, "code_verifier": exchange.verifier])
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let text = String(data: data, encoding: .utf8) ?? ""
                throw CloudAuthError.server(Self.friendlyServerText(text))
            }
            guard http.value(forHTTPHeaderField: "x-muster-exchange-version") == String(CloudSignInAttempt.exchangeVersion) else {
                throw CloudAuthError.server("This sign-in response could not be verified. Update Muster and try again.")
            }
            struct ExchangeResponse: Decodable {
                let email: String
                let name: String?
            }
            let decoded = try JSONDecoder().decode(ExchangeResponse.self, from: data)
            guard !decoded.email.isEmpty else {
                throw CloudAuthError.server("The sign-in response had no account.")
            }
            guard attempt.finish(exchange) else { return }
            signingIn = false
            exchangeTask = nil
            store(CloudIdentity(email: decoded.email, name: decoded.name ?? ""))
        } catch {
            // This includes cancellation: obsolete requests must not change
            // the current identity, error, task reference or progress state.
            guard attempt.finish(exchange) else { return }
            signingIn = false
            exchangeTask = nil
            self.error = (error as? CloudAuthError)?.message
                ?? "Could not reach muster.today to finish signing in. Check the network and try again."
        }
    }

    /// The exchange answers {error: "human text"} on failure; anything else
    /// degrades to the generic line rather than leaking a raw body.
    private static func friendlyServerText(_ body: String) -> String {
        if let data = body.data(using: .utf8),
           let parsed = try? JSONDecoder().decode([String: String].self, from: data),
           let message = parsed["error"], !message.isEmpty {
            return message
        }
        return "Sign-in could not be completed. Start again from Muster."
    }

    private static func friendly(_ err: Error) -> String {
        if let asError = err as? ASWebAuthenticationSessionError, asError.code == .presentationContextInvalid {
            return "Sign-in could not be shown. Try again."
        }
        return "Sign-in did not finish. Try again."
    }


}

extension CloudAuth: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first ?? ASPresentationAnchor()
    }
}

private enum CloudAuthError: LocalizedError {
    case server(String)

    var message: String {
        switch self {
        case let .server(text): return text
        }
    }
}

/// Never forward the one-time code or verifier to a redirected destination.
private final class CloudIdentityRedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
    static let shared = CloudIdentityRedirectPolicy()
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
