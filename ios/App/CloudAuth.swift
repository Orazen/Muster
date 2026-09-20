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
    /// The code currently being exchanged, so a duplicate delivery of the
    /// same callback URL is idempotent.
    private var inFlightCode: String?

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
        store(nil)
        error = nil
    }

    /// Step 1: present the cloud's Google sign-in in an ephemeral web sheet.
    func startSignIn() {
        guard !signingIn else { return }
        error = nil
        var components = URLComponents(url: Self.cloudBase, resolvingAgainstBaseURL: false)!
        components.path = "/desktop-auth/start"
        components.queryItems = [
            URLQueryItem(name: "redirect", value: Self.callbackURL.absoluteString),
        ]
        let session = ASWebAuthenticationSession(url: components.url!, callbackURLScheme: Self.callbackScheme) { [weak self] callback, err in
            Task { @MainActor in
                guard let self else { return }
                self.signingIn = false
                if let callback {
                    _ = self.handleCallback(callback)
                } else if let err, (err as? ASWebAuthenticationSessionError)?.code != .canceledLogin {
                    self.error = Self.friendly(err)
                }
            }
        }
        // Ephemeral: the sign-in cookie lives only for this handshake. The
        // app keeps nothing but the finished identity.
        session.prefersEphemeralWebBrowserSession = true
        session.presentationContextProvider = self
        webSession = session
        signingIn = true
        guard session.start() else {
            signingIn = false
            error = "Could not open the sign-in window. Try again."
            webSession = nil
            return
        }
    }

    /// Step 2: catch `muster://oauth/finish#code=…`. Delivered either by the
    /// web session's completion handler or by onOpenURL — the guard makes
    /// both idempotent. Returns true when the URL was ours.
    @discardableResult
    func handleCallback(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == Self.callbackScheme,
              url.host?.lowercased() == "oauth",
              url.path.isEmpty || url.path == "/finish"
        else { return false }
        let fragment = URLComponents(url: url, resolvingAgainstBaseURL: false)?.fragment ?? ""
        let params = Self.fragmentParams(fragment)
        guard let code = params["code"], !code.isEmpty else {
            error = "Sign-in finished without a code. Start again."
            return true
        }
        guard !signingIn, inFlightCode == nil else { return true } // duplicate delivery
        inFlightCode = code
        signingIn = true
        Task { [weak self] in
            await self?.exchange(code: code)
        }
        return true
    }

    /// Step 3: burn the one-time code against the cloud for the identity.
    /// 90-second TTL, single-use — a retry that loses the race reports the
    /// server's own "expired or used" text.
    private func exchange(code: String) async {
        defer {
            inFlightCode = nil
            signingIn = false
        }
        var components = URLComponents(url: Self.cloudBase, resolvingAgainstBaseURL: false)!
        components.path = "/api/desktop-auth/exchange"
        guard let url = components.url else {
            error = "Sign-in is misconfigured."
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 20
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let text = String(data: data, encoding: .utf8) ?? ""
                throw CloudAuthError.server(Self.friendlyServerText(text))
            }
            let decoded = try JSONDecoder().decode([String: String].self, from: data)
            guard let email = decoded["email"], !email.isEmpty else {
                throw CloudAuthError.server("The sign-in response had no account.")
            }
            store(CloudIdentity(email: email, name: decoded["name"] ?? ""))
        } catch let err as CloudAuthError {
            error = err.message
        } catch {
            self.error = "Could not reach muster.today to finish signing in. Check the network and try again."
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

    /// Fragment params without percent-decoding surprises: split on & then =,
    /// exactly like PairingInvite does for its query.
    private static func fragmentParams(_ fragment: String) -> [String: String] {
        var out: [String: String] = [:]
        for field in fragment.split(separator: "&") {
            guard let equal = field.firstIndex(of: "=") else { continue }
            let name = String(field[..<equal]).removingPercentEncoding ?? String(field[..<equal])
            let value = String(field[field.index(after: equal)...]).removingPercentEncoding ?? ""
            out[name] = value
        }
        return out
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
