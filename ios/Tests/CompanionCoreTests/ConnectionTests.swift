import XCTest
@testable import CompanionCore

final class ConnectionTests: XCTestCase {
    func testParsesHostnamesAndPorts() {
        let implicit = Connection.parse("macbook.tailnet.ts.net")
        XCTAssertEqual(implicit?.host, "macbook.tailnet.ts.net")
        XCTAssertEqual(implicit?.port, 8810)

        let explicit = Connection.parse("http://192.168.1.42:9910/")
        XCTAssertEqual(explicit?.host, "192.168.1.42")
        XCTAssertEqual(explicit?.port, 9910)
    }

    func testParsesIPv6WithAndWithoutAnExplicitPort() {
        let bare = Connection.parse("2001:db8::1")
        XCTAssertEqual(bare?.host, "[2001:db8::1]")
        XCTAssertEqual(bare?.port, 8810)
        XCTAssertEqual(bare?.baseURL?.absoluteString, "http://[2001:db8::1]:8810")

        let explicit = Connection.parse("[2001:db8::1]:9910")
        XCTAssertEqual(explicit?.host, "[2001:db8::1]")
        XCTAssertEqual(explicit?.port, 9910)
        XCTAssertEqual(explicit?.baseURL?.absoluteString, "http://[2001:db8::1]:9910")
    }

    func testRetainsTheScopeZoneOnLinkLocalIPv6() {
        let connection = Connection.parse("[fe80::1%en0]:8810")
        XCTAssertEqual(connection?.host, "[fe80::1%en0]")
        XCTAssertEqual(connection?.baseURL?.absoluteString, "http://[fe80::1%25en0]:8810")
    }

    func testAnOlderSavedIPv6ConnectionIsNormalizedWhenUsed() throws {
        let data = Data(#"{"id":"saved","name":"Mac","host":"::1","port":8810}"#.utf8)
        let saved = try JSONDecoder().decode(Connection.self, from: data)
        XCTAssertEqual(saved.baseURL?.absoluteString, "http://[::1]:8810")
    }

    func testRejectsAmbiguousOrUnsafeAddresses() {
        XCTAssertNil(Connection.parse("host:not-a-port"))
        XCTAssertNil(Connection.parse("[::1]:not-a-port"))
        XCTAssertNil(Connection.parse("[::1]:70000"))
        XCTAssertNil(Connection.parse("host/path"))
        XCTAssertNil(Connection.parse("host name"))
    }

    func testParsesADesktopPairingInvite() throws {
        let token = "omb_pair_" + String(repeating: "a", count: 43)
        let url = try XCTUnwrap(URL(string: "muster://pair?address=macbook.tail1234.ts.net%3A8810&token=\(token)&code=004209&name=Alex%27s%20Mac"))
        let invite = try XCTUnwrap(PairingInvite.parse(url))
        XCTAssertEqual(invite.connection.host, "macbook.tail1234.ts.net")
        XCTAssertEqual(invite.connection.port, 8810)
        XCTAssertEqual(invite.connection.name, "Alex's Mac")
        XCTAssertEqual(invite.credential, token)
    }

    func testParsesAnOlderCodeOnlyPairingInvite() throws {
        let url = try XCTUnwrap(URL(string: "muster://pair?address=mac.local&code=004209"))
        XCTAssertEqual(PairingInvite.parse(url)?.credential, "004209")
    }

    func testRejectsAnUntrustedOrMalformedPairingInvite() throws {
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "https://example.com/pair?address=mac.local&code=123456"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "muster://pair?address=mac.local&code=12345"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "muster://pair?address=mac.local&token=weak"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "muster://pair?address=mac.local&token=weak&code=123456"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "muster://pair?address=host%2Fpath&code=123456"))))
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "muster://pair?address=one.local&address=two.local&code=123456"))))
    }

    func testAcceptsOnlyAnHTTPSCloudDesktopSession() throws {
        let valid = Data(#"{"joinUrl":"https://desktop.example/session/fresh","state":"ready"}"#.utf8)
        let session = try JSONDecoder().decode(CloudDesktopSession.self, from: valid)
        XCTAssertEqual(session.url.absoluteString, "https://desktop.example/session/fresh")

        for value in [
            "http://desktop.example/session",
            "javascript:alert(1)",
            "not a URL"
        ] {
            let data = try JSONSerialization.data(withJSONObject: ["joinUrl": value])
            XCTAssertThrowsError(try JSONDecoder().decode(CloudDesktopSession.self, from: data))
        }
    }
    func testExplicitSchemesPreserveStandardDefaultPorts() throws {
        for (address, scheme, port) in [("https://example.test", ConnectionScheme.https, 443),
            ("HTTP://example.test/", .http, 80), ("example.test", .http, 8810)] {
            let connection = try XCTUnwrap(Connection.parse(address))
            XCTAssertEqual(connection.scheme, scheme)
            XCTAssertEqual(connection.port, port)
            XCTAssertEqual(connection.baseURL?.scheme, scheme.rawValue)
        }
        XCTAssertEqual(Connection.parse("https://example.test", defaultPort: 9910)?.port, 443)
        XCTAssertEqual(Connection.parse("example.test", defaultPort: 9910)?.port, 9910)
        XCTAssertNil(Connection.parse("example.test", defaultPort: 0))
    }
    func testExplicitPortIsRetainedAndDisplayedWithScheme() throws {
        let connection = try XCTUnwrap(Connection.parse("https://example.test:8443/"))
        XCTAssertEqual(connection.port, 8443)
        XCTAssertEqual(connection.displayAddress, "https://example.test:8443")
        let reparsed = try XCTUnwrap(Connection.parse(connection.displayAddress))
        XCTAssertEqual(reparsed.scheme, .https)
        XCTAssertEqual(reparsed.host, connection.host)
        XCTAssertEqual(reparsed.port, connection.port)
        XCTAssertEqual(Connection.parse("http://example.test:443")?.scheme, .http)
    }
    func testHTTPSIPv6AndZoneDisplayRoundtrip() throws {
        for address in ["https://[2001:db8::1]", "https://[::ffff:192.0.2.1]:8443", "https://[fe80::1%25en0]:8443", "https://[fe80::1%en0]:8443"] {
            let connection = try XCTUnwrap(Connection.parse(address), address)
            XCTAssertEqual(connection.scheme, .https)
            let again = try XCTUnwrap(Connection.parse(connection.displayAddress))
            XCTAssertEqual(again.host, connection.host)
            XCTAssertEqual(again.port, connection.port)
            XCTAssertEqual(again.scheme, .https)
        }
        XCTAssertEqual(Connection.parse("https://[fe80::1%25en0]")?.host, "[fe80::1%en0]")
        XCTAssertEqual(Connection.parse("fe80::1%en0")?.baseURL?.absoluteString, "http://[fe80::1%25en0]:8810")
    }
    func testLegacyPersistencePreservesIdentityAndStoredAddressBytes() throws {
        let raw = Data(#"{"id":"original-keychain-id","name":"My Mac","host":"::1","port":9910}"#.utf8)
        let connection = try JSONDecoder().decode(Connection.self, from: raw)
        XCTAssertEqual(connection.id, "original-keychain-id")
        XCTAssertEqual(connection.name, "My Mac")
        XCTAssertEqual(connection.host, "::1", "Decode must not rewrite legacy saved address bytes")
        XCTAssertEqual(connection.port, 9910)
        XCTAssertEqual(connection.scheme, .http)
        let reloaded = try JSONDecoder().decode(Connection.self, from: JSONEncoder().encode(connection))
        XCTAssertEqual(reloaded, connection)
        XCTAssertEqual(reloaded.id, "original-keychain-id")
    }
    func testHTTPSPersistenceDoesNotLoseSchemeOrTokenLookupIdentity() throws {
        let connection = Connection(id: "stable-token-key", name: "TLS Mac", host: "example.test", port: 443, scheme: .https)
        let data = try JSONEncoder().encode(connection)
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(raw["scheme"] as? String, "https")
        XCTAssertNil(raw["token"])
        let decoded = try JSONDecoder().decode(Connection.self, from: data)
        XCTAssertEqual(decoded, connection)
        XCTAssertEqual(decoded.baseURL?.absoluteString, "https://example.test:443")
    }
    func testMalformedPersistedSchemeNeverDefaultsToHTTP() throws {
        for scheme: Any in [NSNull(), "ftp", "HTTPS", 1, true, ["https"]] {
            let raw: [String: Any] = ["id": "saved", "name": "Mac", "host": "example.test", "port": 443, "scheme": scheme]
            XCTAssertThrowsError(try JSONDecoder().decode(Connection.self, from: JSONSerialization.data(withJSONObject: raw)), "\(scheme)")
        }
    }
    func testMalformedPersistedAuthorityIsRejected() throws {
        for (host, port) in [("user@example.test", 443), ("host/path", 443), ("[example.test]", 443), ("::broken", 443), ("host", 0), ("host", 65536)] {
            let raw: [String: Any] = ["id": "saved", "name": "Mac", "host": host, "port": port]
            XCTAssertThrowsError(try JSONDecoder().decode(Connection.self, from: JSONSerialization.data(withJSONObject: raw)))
        }
    }
    func testMutableAuthorityCannotBypassParserValidation() {
        var connection = Connection(name: "Mac", host: "example.test", port: 443, scheme: .https)
        for host in ["user@example.test", "host/path", "[example.test]", "[::1", "host?query", "host#fragment", "host\\evil", "host\n", "127.1", "0177.0.0.1"] {
            connection.host = host
            XCTAssertNil(connection.baseURL, host)
        }
        connection.host = "example.test"; connection.port = 0
        XCTAssertNil(connection.baseURL)
        connection.port = 443; connection.scheme = .http
        XCTAssertEqual(connection.baseURL?.scheme, "http", "Explicit user-selected HTTP remains available")
    }
    func testRejectsCredentialsPathsQueriesFragmentsAndControls() {
        for address in ["https://user@example.test", "https://user:pass@example.test", "https://example.test/path", "https://example.test//",
            "https://example.test?", "https://example.test#", "example.test?x=1", "host\\path", "https://host\n", "\thost", "host\u{7f}", "host name"] {
            XCTAssertNil(Connection.parse(address), address)
        }
    }
    func testRejectsUnsupportedAndAmbiguousAuthorities() {
        for address in ["ftp://host", "file://host", "javascript:alert(1)", "//host", "https:///host", "https://", "https://::1", "https://2001:db8::1:443",
            "[host]:443", "[::1]other", "[::1]:", "host:", "host:+80", "host:-1", "host:0", "host:65536", "host:８０", "host:1e2", "host:443:extra"] {
            XCTAssertNil(Connection.parse(address), address)
        }
    }
    func testStrictIPv4RejectsAlternativeNumericAuthorities() {
        for host in ["127.1", "127.0.1", "2130706433", "0x7f.0.0.1", "0177.0.0.1", "127.0.0.01", "256.1.2.3", "127.0.0.1."] {
            XCTAssertNil(Connection.parse(host), host)
        }
        XCTAssertEqual(Connection.parse("192.168.1.42")?.host, "192.168.1.42")
        XCTAssertEqual(Connection.parse("0.0.0.0:8810")?.port, 8810)
    }
    func testDNSAndIPv6ValidationRejectsMalformedHosts() {
        for host in ["bad..host", ".host", "-host.local", "host-.local", "host_name.local", "host%20name", "[1::2::3]", "[gggg::1]", "[fe80::1%]", "[fe80::1%en0%other]",
            String(repeating: "a", count: 64) + ".test"] {
            XCTAssertNil(Connection.parse(host), host)
        }
        for host in ["localhost", "Mac.local", "xn--bcher-kva.example", "host.example.", "::", "2001:db8::1", "[::ffff:192.0.2.1]"] {
            XCTAssertNotNil(Connection.parse(host), host)
        }
    }
    func testInvitePreservesHTTPSAndStandardPort() throws {
        let url = try XCTUnwrap(URL(string: "muster://pair?address=https%3A%2F%2Fexample.test&code=004209"))
        let invite = try XCTUnwrap(PairingInvite.parse(url))
        XCTAssertEqual(invite.connection.scheme, .https)
        XCTAssertEqual(invite.connection.port, 443)
        XCTAssertEqual(invite.connection.displayAddress, "https://example.test:443")
    }
    func testInviteRejectsUnexpectedAuthorityPathAndFragment() throws {
        for prefix in ["muster://user@pair", "muster://user:pass@pair", "muster://pair:123", "muster://pair/unexpected", "muster://pair/%2e", "muster://%70air", "muster://pair//"] {
            XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: prefix + "?address=host&code=004209"))), prefix)
        }
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "muster://pair?address=host&code=004209#fragment"))))
        XCTAssertNotNil(PairingInvite.parse(try XCTUnwrap(URL(string: "muster://pair/?address=host&code=004209"))))
    }
    func testInviteRejectsDuplicateDecodedUnknownAndEmptyFields() throws {
        for query in ["address=host&%61ddress=other&code=004209", "address=host&code=004209&%63ode=123456", "address=host&code=004209&extra=yes",
            "address=host&code=004209&", "address=host&code=004209&name", "address=&code=004209", "address=host&token=&code=004209"] {
            XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "muster://pair?" + query))), query)
        }
    }
    func testInviteDoesNotTurnEscapedSeparatorsIntoParameters() throws {
        let valid = try XCTUnwrap(URL(string: "muster://pair?address=host&code=004209&name=Mac%26code%3D123456"))
        let invite = try XCTUnwrap(PairingInvite.parse(valid))
        XCTAssertEqual(invite.credential, "004209")
        XCTAssertEqual(invite.connection.name, "Mac&code=123456")
        XCTAssertNil(PairingInvite.parse(try XCTUnwrap(URL(string: "muster://pair?address=host%26token%3Dweak&code=004209"))))
    }
    func testInviteTokenWinsWithoutFallbackFromInvalidToken() throws {
        let token = "omb_pair_" + String(repeating: "a", count: 43)
        let valid = try XCTUnwrap(URL(string: "muster://pair?address=host&token=\(token)&code=wrong"))
        XCTAssertEqual(PairingInvite.parse(valid)?.credential, token)
        for bad in ["weak", "omb_pair_" + String(repeating: "a", count: 42), token + "a", "omb_pair_" + String(repeating: "!", count: 43)] {
            var parts = URLComponents(string: "muster://pair")!
            parts.queryItems = [.init(name: "address", value: "host"), .init(name: "token", value: bad), .init(name: "code", value: "004209")]
            XCTAssertNil(PairingInvite.parse(try XCTUnwrap(parts.url)))
        }
    }

    func testDesktopFormEncodedNamePreservesSpacesAndLiteralPlus() throws {
        let url = try XCTUnwrap(URL(string: "muster://pair?address=host&code=004209&name=Alex%27s+Mac%2BWork"))
        let invite = try XCTUnwrap(PairingInvite.parse(url))
        XCTAssertEqual(invite.connection.name, "Alex's Mac+Work")
        XCTAssertEqual(invite.credential, "004209")
    }

}
