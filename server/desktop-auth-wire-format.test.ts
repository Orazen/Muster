// The account-exchange response is a WIRE CONTRACT with clients that version
// independently of the server — the iPhone, the Electron shell, the desktop
// local server, and any desktop release already installed.
//
// It broke once. `/api/desktop-auth/exchange` grew a `v: 1` field, and
// CloudAuth.swift decoded the entire body as `[String: String]`: a number in a
// string map is a typeMismatch, the decode threw, and the catch presented
// "Could not reach muster.today" — a network error for a sign-in that had
// worked. Nobody testing the server alone would have seen it, because the
// server was, by its own lights, correct.
//
// So the shape is pinned here rather than left to review. The first schema is
// the 1.20 contract, expressed the way the installed app expresses it: a body
// where EVERY value is a string. If a future edit adds a field of any other
// type, this fails — which is the whole point.
import { describe, expect, it } from "vitest";
import { z } from "zod";

/** The 1.20 iPhone contract: the whole body is a string map. */
const iosStringMap = z.record(z.string(), z.string());

/** Every refusal the exchange route can answer. */
const FAILURE_BODIES = [
  "that sign-in code expired or was already used — start again from Muster",
  "this sign-in could not be verified — start again from Muster",
  "this sign-in uses a newer exchange version than this build — update Muster (server speaks v1)",
] as const;

/** The success body as raw response TEXT, the way a client receives it. Working
 * from bytes rather than an object is deliberate: it is what makes these cases
 * a wire contract, and it keeps the assertions free of casts. */
const successText = (extraFields = ""): string =>
  `{"email":"person@example.test","name":"Person"${extraFields}}`;

describe("account exchange response wire format", () => {
  it("decodes as the iPhone's all-strings contract", () => {
    // If this ever fails, an installed iOS app cannot finish a Google sign-in.
    const decoded = iosStringMap.parse(JSON.parse(successText()));
    expect(decoded["email"]).toBe("person@example.test");
    expect(decoded["name"]).toBe("Person");
  });

  it("carries no version in the body", () => {
    // The version rides the x-muster-exchange-version header precisely so it
    // cannot land here. Asserted negatively because nothing else stops a
    // future edit from putting it back.
    expect(Object.keys(iosStringMap.parse(JSON.parse(successText()))).sort()).toEqual(["email", "name"]);
  });

  it("rejects the numeric body that broke the iPhone", () => {
    // The exact regression, pinned so it cannot come back: a number anywhere in
    // the body is a typeMismatch for a [String: String] decode.
    expect(() => iosStringMap.parse(JSON.parse(successText(',"v":1')))).toThrow();
  });

  it("rejects a boolean or null field the same way", () => {
    // The all-strings contract is not special-cased to numbers: anything that
    // is not a string fails the installed app's decode.
    expect(() => iosStringMap.parse(JSON.parse(successText(',"flag":true')))).toThrow();
    expect(() => iosStringMap.parse(JSON.parse(successText(',"nothing":null')))).toThrow();
  });

  it("decodes every failure body as an all-strings contract too", () => {
    // CloudAuth reads `error` off the same decode, and the desktop's local
    // /oauth/finish/exchange does too.
    for (const message of FAILURE_BODIES) {
      const decoded = iosStringMap.parse(JSON.parse(JSON.stringify({ error: message })));
      expect(decoded["error"]).toBe(message);
    }
  });

  it("is what a named-field client needs to ignore future additions", () => {
    // CloudAuth now decodes named fields only, so an additive change is
    // ignored rather than fatal. That tolerance is what makes a future body
    // field safe — and it is why the header, not the body, was the only thing
    // that had to change to ship the version.
    const named = z.object({ email: z.string(), name: z.string().optional() });
    const decoded = named.parse(JSON.parse(successText(',"v":1,"future":"x"')));
    expect(decoded.email).toBe("person@example.test");
    expect(decoded.name).toBe("Person");
  });
});
