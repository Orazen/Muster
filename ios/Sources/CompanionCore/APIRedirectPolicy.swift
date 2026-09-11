import Foundation

/// A paired API address is fixed. Following even a same-origin redirect can
/// replay a mutation at a different route, so neither API data nor pairing
/// credentials are redirected. No authentication challenge is overridden.
final class APIRedirectPolicy: NSObject, URLSessionTaskDelegate, Sendable {
    static let shared = APIRedirectPolicy()

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    static func validate(_ session: URLSession) throws {
        // Background configurations follow redirects without invoking this
        // delegate. The companion's foreground API cannot use them.
        guard session.configuration.identifier == nil else {
            throw APIError.transport("Background sessions cannot be used for this computer connection.")
        }
    }

    static func check(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("The computer returned an unrecognized HTTP response.")
        }
        if (300..<400).contains(http.statusCode) {
            throw APIError.status(code: http.statusCode,
                message: "The computer redirected this API request. Connect using its direct address and try again.")
        }
    }
}
