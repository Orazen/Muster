// Deterministic tests for the C0 agent-payment policy contract.
//
// Everything here is a local mock: no network, no SDK, no key, no card, no
// wallet and no transaction. The clock is always a literal argument, so every
// expiry/timeout assertion is exact rather than timing-dependent.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  AGENT_PAYMENT_PERMITTED_RAILS,
  AGENT_TOKEN_CHAINS,
  AGENT_WALLET_PROVEN_OPERATIONS,
  AgentPaymentPolicyError,
  AgentPurchaseApprovalRegistry,
  AgentPurchaseBudgetLedger,
  agentPaymentAmountsEqual,
  agentPaymentMinorUnitExponent,
  assertNoSensitivePaymentMaterial,
  assertRegisteredTokenAsset,
  authorizeAgentPaidCall,
  authorizeAgentPaymentPurchase,
  authorizeAgentWalletOperation,
  assertAgentRevocationsConfirmed,
  createAgentPurchaseApproval,
  deriveAgentPaymentBuyer,
  disconnectAgentPayments,
  formatAgentPaymentAmount,
  isOpaquePaymentMethodRef,
  looksLikeCardNumber,
  parseAgentPaymentDecimal,
  parseAgentPurchaseRequest,
  parseAgentWalletScope,
  prepareAgentPurchase,
  resolveAgentTokenAsset,
  restoreAgentPaymentAuthority,
  revokeAgentPaymentAuthority,
  selectAgentPaymentRail,
  type AgentPaidCallConsent,
  type AgentPaidCallRequest,
  type AgentPaymentAmount,
  type AgentPaymentAuthority,
  type AgentPaymentBuyerMapping,
  type AgentPaymentDecision,
  type AgentPaymentDenialCode,
  type AgentPaymentRefusal,
  type AgentPaymentSession,
  type AgentPurchaseApproval,
  type AgentPurchaseRequest,
  type AgentRailCapability,
  type AgentTokenAsset,
  type AgentWalletScope,
} from "./agent-payment-policy.ts";

// ── fixtures ───────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000;
const digest = (fill: string): string => `sha256:${fill.repeat(64)}`;
const usd = (minorUnits: number): AgentPaymentAmount => ({ currency: "USD", minorUnits });

const SESSION: AgentPaymentSession = { ownerId: "own_alpha", deviceId: "dev_alpha" };
const MAPPING: AgentPaymentBuyerMapping = {
  ownerId: "own_alpha",
  deviceId: "dev_alpha",
  providerId: "prv_mock",
  environment: "sandbox",
  buyerId: "byr_alpha",
};

const CAPABILITIES: readonly AgentRailCapability[] = [
  { rail: "visa_intelligent_commerce", enforcementVerified: true, supportObserved: true, cardEligible: true },
  { rail: "mastercard_agent_pay", enforcementVerified: true, supportObserved: true, cardEligible: false },
];

const baseApproval = (overrides: Partial<AgentPurchaseApproval> = {}): AgentPurchaseApproval => ({
  approvalId: "ap_book_01",
  revision: 1,
  ownerId: "own_alpha",
  taskId: "tsk_research",
  deviceId: "dev_alpha",
  providerId: "prv_mock",
  buyerId: "byr_alpha",
  environment: "sandbox",
  paymentMethodRef: "pm_mockcard_01",
  rail: "visa_intelligent_commerce",
  payee: "pay_bookseller",
  origin: "https://books.example",
  itemDigest: digest("a"),
  amount: usd(5_000),
  maxTotal: usd(6_000),
  recurring: false,
  issuedAt: T0,
  expiresAt: T0 + 600_000,
  disclosureReceiptId: "dsc_01",
  ...overrides,
});

const baseRequest = (overrides: Partial<AgentPurchaseRequest> = {}): AgentPurchaseRequest => ({
  approvalId: "ap_book_01",
  approvalRevision: 1,
  ownerId: "own_alpha",
  taskId: "tsk_research",
  deviceId: "dev_alpha",
  providerId: "prv_mock",
  environment: "sandbox",
  rail: "visa_intelligent_commerce",
  paymentMethodRef: "pm_mockcard_01",
  payee: "pay_bookseller",
  origin: "https://books.example",
  itemDigest: digest("a"),
  amountMinorUnits: 5_000,
  currency: "USD",
  recurring: false,
  executorId: "exe_alpha",
  ...overrides,
});

/** A registry plus a ledger configured for one owner, in the only shape the
 * tests ever need. */
interface SeededPaymentContext {
  registry: AgentPurchaseApprovalRegistry;
  ledger: AgentPurchaseBudgetLedger;
}

const seeded = (
  approvalOverrides: Partial<AgentPurchaseApproval> = {},
  limit = 10_000,
): SeededPaymentContext => {
  const registry = new AgentPurchaseApprovalRegistry();
  const stored = registry.put(baseApproval(approvalOverrides));
  if (stored.outcome === "refused") throw new Error(stored.reason);
  const ledger = new AgentPurchaseBudgetLedger();
  const limitResult = ledger.setLimit("own_alpha", "USD", limit);
  if (limitResult.outcome === "refused") throw new Error(limitResult.reason);
  return { registry, ledger };
};

const refusalCode = (decision: AgentPaymentRefusal | { outcome: "authorized" }): AgentPaymentDenialCode => {
  if (decision.outcome === "refused") return decision.code;
  throw new Error(`expected a refusal, got authorized: ${JSON.stringify(decision)}`);
};

const approved = <T>(decision: AgentPaymentDecision<T>): T => {
  if (decision.outcome === "refused") throw new Error(`expected authorized, got ${decision.code}: ${decision.reason}`);
  return decision;
};

const authorizeWith = (
  registry: AgentPurchaseApprovalRegistry,
  request: AgentPurchaseRequest,
  now = T0 + 1_000,
  mapping: AgentPaymentBuyerMapping = MAPPING,
  session: AgentPaymentSession = SESSION,
  capabilities: readonly AgentRailCapability[] = CAPABILITIES,
) => authorizeAgentPaymentPurchase(registry, session, mapping, capabilities, request, now);

const reserve = async (ledger: AgentPurchaseBudgetLedger, amountMinorUnits: number, approvalId: string) =>
  ledger.reserve({
    ownerId: "own_alpha",
    approvalId,
    approvalRevision: 1,
    currency: "USD",
    amountMinorUnits,
    executorId: "exe_alpha",
    now: T0 + 1_000,
  });

// ── money: integers, never binary floating point ───────────────────────

describe("money is integer minor units", () => {
  it("parses a two-decimal value that binary floating point overshoots", () => {
    // Number("1.10") * 100 === 110.00000000000001 — a cap that grows by a
    // fraction of a cent nobody approved. The parser is string + BigInt.
    expect(Number("1.10") * 100).not.toBe(110);
    expect(Number("1.10") * 100).toBeGreaterThan(110);
    expect(parseAgentPaymentDecimal("1.10", "USD")).toEqual({ currency: "USD", minorUnits: 110 });
  });

  it("sums minor units exactly where a float cart total drifts a cent low", () => {
    const prices = [145, 145, 145];
    const floatTotal = prices.reduce((sum, minor) => sum + minor / 100, 0) * 100;
    const integerTotal = prices.reduce((sum, minor) => sum + minor, 0);
    expect(integerTotal).toBe(435);
    expect(floatTotal).toBe(434.99999999999994);
  });

  it.each([
    ["USD", 2, "1234.5", "1234.50", 123_450],
    ["JPY", 0, "1234", "1234", 1_234],
    ["BHD", 3, "1234.5", "1234.500", 1_234_500],
  ])("round-trips %s through its own exponent", (currency, exponent, input, rendered, minorUnits) => {
    expect(agentPaymentMinorUnitExponent(currency)).toBe(exponent);
    const parsed = parseAgentPaymentDecimal(input, currency);
    expect(parsed).toEqual({ currency, minorUnits });
    expect(formatAgentPaymentAmount(parsed)).toBe(rendered);
    expect(parseAgentPaymentDecimal(rendered, currency).minorUnits).toBe(minorUnits);
  });

  it("refuses excess precision rather than rounding it away", () => {
    // 1.005 is 101 cents if you round, 100 if you truncate, and a cap is
    // neither: it is refused.
    expect(Number("1.005") * 100).not.toBe(101);
    expect(() => parseAgentPaymentDecimal("1.005", "USD")).toThrow(
      expect.objectContaining({ code: "amount_not_integer_minor_units" }),
    );
    expect(parseAgentPaymentDecimal("1.005", "BHD")).toEqual({ currency: "BHD", minorUnits: 1_005 });
  });

  it.each(["1.005", "1e3", "+1.00", "-1.00", " 1.00", "1,000.00", ".50", "1.00 ", "Infinity", "NaN"])(
    "refuses the decimal string %j instead of rounding it",
    (value) => {
      expect(() => parseAgentPaymentDecimal(value, "USD")).toThrow(AgentPaymentPolicyError);
    },
  );

  it("refuses an unrecognised currency rather than guessing its exponent", () => {
    expect(() => parseAgentPaymentDecimal("10.00", "XYZ")).toThrow(
      expect.objectContaining({ code: "unknown_currency" }),
    );
    expect(() => agentPaymentMinorUnitExponent("BTC")).toThrow(
      expect.objectContaining({ code: "unknown_currency" }),
    );
  });

  it("refuses amounts beyond the safe integer range of minor units", () => {
    expect(() => parseAgentPaymentDecimal("99999999999999999999.00", "USD")).toThrow(
      expect.objectContaining({ code: "amount_not_integer_minor_units" }),
    );
  });

  it("compares amounts by exact integer total and currency", () => {
    expect(agentPaymentAmountsEqual(usd(5_000), usd(5_000))).toBe(true);
    expect(agentPaymentAmountsEqual(usd(5_000), { currency: "EUR", minorUnits: 5_000 })).toBe(false);
    expect(agentPaymentAmountsEqual(usd(5_000), usd(5_001))).toBe(false);
  });

  it("refuses a fractional amount arriving from a tool call", async () => {
    const { registry, ledger } = seeded();
    const prepared = await prepareAgentPurchase(
      registry,
      ledger,
      SESSION,
      MAPPING,
      CAPABILITIES,
      baseRequest({ amountMinorUnits: 5_000.5 }),
      T0 + 1_000,
    );
    expect(refusalCode(prepared)).toBe("amount_not_integer_minor_units");
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(10_000);
  });

  it("refuses a fractional or negative cap or reservation at the ledger boundary", async () => {
    const ledger = new AgentPurchaseBudgetLedger();
    // The integer guard is the boundary check, not a convenience: a cap that
    // is 1000.5 minor units is not a cap.
    expect(() => ledger.setLimit("own_alpha", "USD", 1_000.5)).toThrow(
      expect.objectContaining({ code: "amount_not_integer_minor_units" }),
    );
    expect(() => ledger.setLimit("own_alpha", "USD", -1)).toThrow(
      expect.objectContaining({ code: "negative_amount" }),
    );
    expect(() => ledger.setLimit("own_alpha", "USD", 10_000)).not.toThrow();
    await expect(
      ledger.reserve({
        ownerId: "own_alpha",
        approvalId: "ap_book_01",
        approvalRevision: 1,
        currency: "USD",
        amountMinorUnits: -1,
        executorId: "exe_alpha",
        now: T0,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "negative_amount" }));
    await expect(
      ledger.reserve({
        ownerId: "own_alpha",
        approvalId: "ap_book_01",
        approvalRevision: 1,
        currency: "USD",
        amountMinorUnits: 100.25,
        executorId: "exe_alpha",
        now: T0,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "amount_not_integer_minor_units" }));
    // Nothing was taken by either bad call.
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(10_000);
  });
});

// ── rails: allowlist only, encrypted-card never selected ───────────────

describe("rail selection fails closed", () => {
  it("never permits the encrypted-card fallback and never substitutes another rail", () => {
    for (const rail of ["encrypted_card_fallback", "wallet_transfer", "x402_http_challenge", "mpp_evm"] as const) {
      expect(AGENT_PAYMENT_PERMITTED_RAILS.has(rail)).toBe(false);
      const decision = selectAgentPaymentRail(rail, CAPABILITIES);
      expect(decision.outcome).toBe("refused");
      expect(refusalCode(decision)).toBe(rail === "encrypted_card_fallback" ? "rail_fallback_forbidden" : "rail_not_permitted");
      // Visa was available and was still not chosen on the caller's behalf.
      expect(Object.hasOwn(decision, "rail")).toBe(false);
    }
  });

  it("refuses a permitted rail whose enforcement was never verified", () => {
    const unverified: AgentRailCapability[] = [
      { rail: "visa_intelligent_commerce", enforcementVerified: false, supportObserved: true, cardEligible: true },
    ];
    expect(refusalCode(selectAgentPaymentRail("visa_intelligent_commerce", unverified))).toBe("capability_not_verified");
    expect(refusalCode(selectAgentPaymentRail("visa_intelligent_commerce", []))).toBe("capability_not_verified");
  });

  it("refuses a permitted rail whose support was never observed, or whose card is not eligible", () => {
    expect(
      refusalCode(
        selectAgentPaymentRail("visa_intelligent_commerce", [
          { rail: "visa_intelligent_commerce", enforcementVerified: true, supportObserved: false, cardEligible: true },
        ]),
      ),
    ).toBe("capability_not_verified");
    // Mastercard's rail is verified, but this card is not eligible for it.
    expect(refusalCode(selectAgentPaymentRail("mastercard_agent_pay", CAPABILITIES))).toBe("capability_not_verified");
  });

  it("returns the exact rail that was asked for, and nothing else", () => {
    const decision = approved(selectAgentPaymentRail("visa_intelligent_commerce", CAPABILITIES));
    expect(decision.rail).toBe("visa_intelligent_commerce");
    expect(decision.capability.enforcementVerified).toBe(true);
  });

  it("cannot even construct an approval for the encrypted-card fallback", () => {
    expect(() => createAgentPurchaseApproval(baseApproval({ rail: "encrypted_card_fallback" }))).toThrow(
      expect.objectContaining({ code: "rail_not_permitted" }),
    );
    expect(() => createAgentPurchaseApproval(baseApproval({ rail: "wallet_transfer" }))).toThrow(
      expect.objectContaining({ code: "rail_not_permitted" }),
    );
  });

  it("refuses a request that swaps the approved rail for another permitted one", () => {
    const { registry } = seeded();
    const withCheckout: readonly AgentRailCapability[] = [
      ...CAPABILITIES,
      { rail: "provider_checkout", enforcementVerified: true, supportObserved: true },
    ];
    // The rail is permitted and verified, so the request gets as far as the
    // comparison — and is still refused, because the approval binds Visa.
    expect(refusalCode(authorizeWith(registry, baseRequest({ rail: "provider_checkout" }), T0 + 1_000, MAPPING, SESSION, withCheckout))).toBe(
      "rail_not_permitted",
    );
    // Without a capability record the same request fails closed earlier.
    expect(refusalCode(authorizeWith(registry, baseRequest({ rail: "provider_checkout" })))).toBe(
      "capability_not_verified",
    );
  });
});

// ── authority: owner, buyer, task, device, project ─────────────────────

describe("authority is derived, never claimed", () => {
  it("refuses a purchase request carrying another account's id", async () => {
    const { registry, ledger } = seeded();
    const decision = await prepareAgentPurchase(
      registry,
      ledger,
      SESSION,
      MAPPING,
      CAPABILITIES,
      baseRequest({ ownerId: "own_beta" }),
      T0 + 1_000,
    );
    // The approval store is scoped per owner, so another owner's approval id
    // is indistinguishable from a forged one and nothing is reserved.
    expect(refusalCode(decision)).toBe("approval_not_found");
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(10_000);
    expect(registry.consumptionOf("own_alpha", "ap_book_01", 1)).toBeNull();
  });

  it("another account's approval is invisible to a direct read, not merely refused", () => {
    // The two cases above both drive the refusal through
    // prepareAgentPurchase, and one of them finds the record and then refuses
    // on the session comparison. Neither asserts the thing that actually
    // prevents disclosure: that a lookup by another owner returns NOTHING.
    //
    // Owner isolation here is a property of the composite storage key, not of
    // a filter applied afterwards. A read that fell back to "any record with
    // this approval id" would keep passing both of the tests above — the first
    // would still see a not-found for a request that changed its own owner,
    // and the second would still hit owner_mismatch — while quietly handing
    // one account another account's amount, payee, item digest, buyer id,
    // provider id, disclosure receipt and expiry to anyone who could guess or
    // observe an id. Guessing is exactly the threat model for an opaque id.
    const { registry } = seeded();
    expect(registry.read("own_alpha", "ap_book_01"), "the owner cannot read its own approval").not.toBeNull();
    expect(registry.read("own_beta", "ap_book_01"), "another owner read the record").toBeNull();
    expect(registry.readAt("own_beta", "ap_book_01", 1), "another owner read a past revision").toBeNull();
    expect(
      registry.read("own_beta", "ap_book_01")?.itemDigest,
      "another owner learned the item digest",
    ).toBeUndefined();
  });

  it("refuses a request authenticated as one account but claiming another's approval", async () => {
    const { registry, ledger } = seeded();
    // own_beta's authenticated session, naming own_alpha's approval id. The
    // lookup is scoped by the REQUEST's owner, so the record comes back and
    // the session-versus-record comparison is what refuses it. (The mirror
    // case — own_alpha's session claiming own_beta — finds nothing at all.)
    const decision = await prepareAgentPurchase(
      registry,
      ledger,
      { ownerId: "own_beta", deviceId: "dev_beta" },
      { ...MAPPING, ownerId: "own_beta", deviceId: "dev_beta", buyerId: "byr_beta" },
      CAPABILITIES,
      baseRequest(),
      T0 + 1_000,
    );
    expect(refusalCode(decision)).toBe("owner_mismatch");
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(10_000);
    expect(ledger.readReservation("rsv_own_alpha_1")).toBeNull();
  });

  it("refuses a request that presents another account's session", async () => {
    const { registry, ledger } = seeded();
    // The request's own owner id still resolves the record, so this is caught
    // by the buyer mapping: the authenticated session is not the owner of the
    // account whose mapping and approval were used.
    const decision = authorizeWith(registry, baseRequest({ ownerId: "own_alpha" }), T0 + 1_000, MAPPING, {
      ownerId: "own_beta",
      deviceId: "dev_alpha",
    });
    expect(refusalCode(decision)).toBe("owner_mismatch");
    const prepared = await prepareAgentPurchase(
      registry,
      ledger,
      { ownerId: "own_beta", deviceId: "dev_alpha" },
      MAPPING,
      CAPABILITIES,
      baseRequest(),
      T0 + 1_000,
    );
    expect(refusalCode(prepared)).toBe("owner_mismatch");
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(10_000);
  });

  it("refuses a buyer mapping that belongs to another account", () => {
    const { registry } = seeded();
    expect(refusalCode(authorizeWith(registry, baseRequest(), T0 + 1_000, { ...MAPPING, ownerId: "own_beta" }))).toBe(
      "owner_mismatch",
    );
  });

  it("refuses a forged approval id and a foreign task or device", () => {
    const { registry } = seeded();
    expect(refusalCode(authorizeWith(registry, baseRequest({ approvalId: "ap_not_real" })))).toBe("approval_not_found");
    expect(refusalCode(authorizeWith(registry, baseRequest({ taskId: "tsk_other" })))).toBe("task_mismatch");
    expect(refusalCode(authorizeWith(registry, baseRequest({ deviceId: "dev_beta" })))).toBe("device_mismatch");
    expect(
      refusalCode(
        authorizeWith(registry, baseRequest({ deviceId: "dev_alpha" }), T0 + 1_000, MAPPING, {
          ownerId: "own_alpha",
          deviceId: "dev_beta",
        }),
      ),
    ).toBe("device_mismatch");
  });

  it("derives the buyer from the authenticated mapping and refuses a claimed one", () => {
    expect(approved(deriveAgentPaymentBuyer(SESSION, MAPPING)).authority.buyerId).toBe("byr_alpha");
    // The correct claim is accepted; a wrong one is refused, not ignored.
    expect(approved(deriveAgentPaymentBuyer(SESSION, MAPPING, "byr_alpha")).authority.buyerId).toBe("byr_alpha");
    expect(refusalCode(deriveAgentPaymentBuyer(SESSION, MAPPING, "byr_impostor"))).toBe("buyer_not_derived");
  });

  it("has no project-wide fallback when no per-user subject is mapped", () => {
    const { buyerId: _omitted, ...withoutSubject } = MAPPING;
    expect(refusalCode(deriveAgentPaymentBuyer(SESSION, withoutSubject))).toBe("subject_missing");
    expect(refusalCode(deriveAgentPaymentBuyer(SESSION, { ...MAPPING, ownerId: "own_beta" }))).toBe("owner_mismatch");
  });

  it("refuses a request whose project or environment differs from the approval", () => {
    const { registry } = seeded();
    expect(refusalCode(authorizeWith(registry, baseRequest({ providerId: "prv_other" })))).toBe(
      "project_environment_mismatch",
    );
    expect(refusalCode(authorizeWith(registry, baseRequest({ environment: "production" })))).toBe(
      "project_environment_mismatch",
    );
    // Same project, same environment everywhere: this one is fine, which is
    // what makes the two refusals above meaningful.
    const { registry: productionRegistry } = seeded({ environment: "production" });
    expect(
      approved(
        authorizeWith(
          productionRegistry,
          baseRequest({ environment: "production" }),
          T0 + 1_000,
          { ...MAPPING, environment: "production" },
        ),
      ).approval.environment,
    ).toBe("production");
  });
});

// ── changed terms need a renewed approval ──────────────────────────────

describe("a changed purchase needs renewed approval", () => {
  it.each([
    [{ amountMinorUnits: 5_001 }, "amount_changed"],
    [{ currency: "EUR" }, "currency_changed"],
    [{ itemDigest: digest("b") }, "item_changed"],
    [{ payee: "pay_other" }, "payee_changed"],
    [{ origin: "https://other.example" }, "payee_changed"],
    [{ recurring: true }, "recurrence_added"],
    [{ paymentMethodRef: "pm_mockcard_02" }, "payment_method_changed"],
    [{ rail: "provider_checkout" }, "capability_not_verified"],
  ] as const)("refuses a changed purchase %j", (overrides, code) => {
    const { registry } = seeded();
    expect(refusalCode(authorizeWith(registry, baseRequest(overrides)))).toBe(code);
  });

  it("refuses an expired approval and an amount past the cap at construction", () => {
    const { registry } = seeded();
    expect(refusalCode(authorizeWith(registry, baseRequest(), approvalNow()))).toBe("approval_expired");
    expect(() => createAgentPurchaseApproval(baseApproval({ maxTotal: usd(4_999) }))).toThrow(
      expect.objectContaining({ code: "cap_exceeded" }),
    );
    expect(() => createAgentPurchaseApproval(baseApproval({ expiresAt: T0 }))).toThrow(
      expect.objectContaining({ code: "approval_expired" }),
    );
  });

  it("renews into a new revision and refuses the superseded one", () => {
    const { registry } = seeded();
    const current = registry.read("own_alpha", "ap_book_01");
    if (current === null) throw new Error("approval missing");
    const renewed = approved(registry.renew(current, { amount: usd(9_000), maxTotal: usd(9_500) }, T0 + 2_000));
    expect(renewed.approval.revision).toBe(2);
    expect(renewed.approval.supersedesRevision).toBe(1);
    // The revision the human actually tapped is now stale.
    expect(refusalCode(authorizeWith(registry, baseRequest({ amountMinorUnits: 9_000 }), T0 + 3_000))).toBe(
      "approval_superseded",
    );
    expect(
      approved(
        authorizeWith(
          registry,
          baseRequest({ amountMinorUnits: 9_000, approvalRevision: 2 }),
          T0 + 3_000,
        ),
      ).amount.minorUnits,
    ).toBe(9_000);
  });

  it("refuses a stale write that would overwrite a newer revision", () => {
    const { registry } = seeded();
    const current = registry.read("own_alpha", "ap_book_01");
    if (current === null) throw new Error("approval missing");
    approved(registry.renew(current, { amount: usd(9_000), maxTotal: usd(9_500) }, T0 + 2_000));
    expect(refusalCode(registry.put(baseApproval({ amount: usd(1), maxTotal: usd(2) })))).toBe("approval_superseded");
  });

  it("tells a stale tap which revision replaced it, and refuses a future revision", () => {
    const { registry } = seeded();
    const current = registry.read("own_alpha", "ap_book_01");
    if (current === null) throw new Error("approval missing");
    approved(registry.renew(current, { amount: usd(9_000), maxTotal: usd(9_500) }, T0 + 2_000));
    // Revision 1 is still readable, and it says what replaced it.
    const stale = registry.readAt("own_alpha", "ap_book_01", 1);
    expect(stale?.revision).toBe(1);
    expect(stale?.supersededByRevision).toBe(2);
    const decision = authorizeWith(registry, baseRequest({ amountMinorUnits: 9_000 }), T0 + 3_000);
    expect(refusalCode(decision)).toBe("approval_superseded");
    if (decision.outcome === "refused") expect(decision.reason).toContain("revision 2");
    // Revision 3 never existed, so it is a forged id, not a stale one.
    expect(refusalCode(authorizeWith(registry, baseRequest({ approvalRevision: 3 }), T0 + 3_000))).toBe(
      "approval_not_found",
    );
    expect(registry.readAt("own_alpha", "ap_book_01", 3)).toBeNull();
  });

  it("names the reservation that consumed an approval revision", async () => {
    const { registry, ledger } = seeded();
    const prepared = approved(
      await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000),
    );
    const spent = registry.readAt("own_alpha", "ap_book_01", 1);
    expect(spent?.consumedByReservationId).toBe(prepared.reservation.reservationId);
    // The consumed revision is a spent approval, not a missing one.
    const decision = authorizeWith(registry, baseRequest(), T0 + 1_100);
    expect(refusalCode(decision)).toBe("approval_already_consumed");
    if (decision.outcome === "refused") expect(decision.reason).toContain(prepared.reservation.reservationId);
  });

  it("refuses a consumed approval instead of funding a second purchase", async () => {
    const { registry, ledger } = seeded();
    approved(await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000));
    const second = await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_100);
    expect(refusalCode(second)).toBe("approval_already_consumed");
  });

  it("does not consume the approval when the reservation cannot be taken", async () => {
    const { registry, ledger } = seeded({}, 1_000);
    const refused = await prepareAgentPurchase(
      registry,
      ledger,
      SESSION,
      MAPPING,
      CAPABILITIES,
      baseRequest(),
      T0 + 1_000,
    );
    // The approved cap is 6000 and the budget is 1000: nothing is reserved and
    // nothing is consumed, so raising the cap later still works.
    expect(refusalCode(refused)).toBe("budget_exhausted");
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(1_000);
    expect(registry.consumptionOf("own_alpha", "ap_book_01", 1)).toBeNull();
    approved(ledger.setLimit("own_alpha", "USD", 20_000));
    expect(
      (await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_200)).outcome,
    ).toBe("authorized");
  });
});

const approvalNow = (): number => T0 + 600_000;

// ── atomic reservation ─────────────────────────────────────────────────

describe("budget reservations are atomic", () => {
  it("holds the approved cap, not the quote, so fees cannot exceed it", async () => {
    const { registry, ledger } = seeded({}, 10_000);
    const prepared = approved(
      await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000),
    );
    expect(prepared.cap).toEqual(usd(6_000));
    expect(prepared.reservation.reservedMinorUnits).toBe(6_000);
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(4_000);
  });

  it("refuses concurrent reservations that would together overspend", async () => {
    const ledger = new AgentPurchaseBudgetLedger();
    approved(ledger.setLimit("own_alpha", "USD", 1_000));
    const results = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) => reserve(ledger, 300, `ap_conc_${index}`)),
    );
    expect(results.filter((result) => result.outcome === "authorized")).toHaveLength(3);
    expect(results.filter((result) => result.outcome === "refused").map(refusalCode)).toEqual([
      "budget_exhausted",
      "budget_exhausted",
    ]);
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(100);
    expect(ledger.readBudget("own_alpha", "USD")?.reservedMinorUnits).toBe(900);
  });

  it("refuses concurrent full-path purchases that would together overspend", async () => {
    const registry = new AgentPurchaseApprovalRegistry();
    const ledger = new AgentPurchaseBudgetLedger();
    approved(ledger.setLimit("own_alpha", "USD", 1_000));
    for (let index = 0; index < 5; index += 1) {
      approved(
        registry.put(
          baseApproval({
            approvalId: `ap_race_${index}`,
            amount: usd(300),
            maxTotal: usd(300),
          }),
        ),
      );
    }
    const results = await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        prepareAgentPurchase(
          registry,
          ledger,
          SESSION,
          MAPPING,
          CAPABILITIES,
          baseRequest({ approvalId: `ap_race_${index}`, amountMinorUnits: 300 }),
          T0 + 1_000,
        ),
      ),
    );
    expect(results.filter((result) => result.outcome === "authorized")).toHaveLength(3);
    expect(results.filter((result) => result.outcome === "refused").map(refusalCode)).toEqual([
      "budget_exhausted",
      "budget_exhausted",
    ]);
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(100);
    expect(ledger.readBudget("own_alpha", "USD")?.reservedMinorUnits).toBe(900);
  });

  it("refuses a reservation for a currency with no configured budget", async () => {
    const ledger = new AgentPurchaseBudgetLedger();
    const decision = await ledger.reserve({
      ownerId: "own_alpha",
      approvalId: "ap_book_01",
      approvalRevision: 1,
      currency: "EUR",
      amountMinorUnits: 100,
      executorId: "exe_alpha",
      now: T0,
    });
    expect(refusalCode(decision)).toBe("budget_not_configured");
  });

  it("refuses to shrink a limit below what is already committed", async () => {
    const ledger = new AgentPurchaseBudgetLedger();
    approved(ledger.setLimit("own_alpha", "USD", 1_000));
    approved(await reserve(ledger, 600, "ap_book_01"));
    expect(refusalCode(ledger.setLimit("own_alpha", "USD", 500))).toBe("budget_limit_below_committed");
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(400);
  });
});

// ── unknown outcomes retain the reservation ────────────────────────────

describe("an unknown outcome retains the reservation", () => {
  it("retains the reservation after a create-run timeout with no run id", async () => {
    const { registry, ledger } = seeded();
    const prepared = approved(
      await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000),
    );
    const id = prepared.reservation.reservationId;
    // The create timed out before a run id came back. The local intent stays
    // unknown and its money stays held: a timeout is not proof of nothing.
    const submitted = approved(ledger.markSubmitted(id, { providerRunId: null }, "exe_alpha", T0 + 1_500));
    expect(submitted.reservation.state).toBe("retained_unknown");
    expect(submitted.reservation.submissionStarted).toBe(true);
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(4_000);
    // Freeing it now would be a blind replay of a possibly-live purchase.
    expect(refusalCode(ledger.voidReservation(id, "exe_alpha", T0 + 1_600))).toBe("outcome_unknown");
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(4_000);
    expect(ledger.unresolved("own_alpha").map((row) => row.reservationId)).toEqual([id]);
  });

  it("frees a reservation only when no effect was ever started", async () => {
    const { registry, ledger } = seeded();
    const prepared = approved(
      await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000),
    );
    const id = prepared.reservation.reservationId;
    approved(ledger.voidReservation(id, "exe_alpha", T0 + 1_100));
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(10_000);
    expect(ledger.readReservation(id)?.state).toBe("voided");
    expect(refusalCode(ledger.voidReservation(id, "exe_alpha", T0 + 1_200))).toBe("reservation_voided");
  });

  it.each([
    [{ state: "unknown" as const, reason: "no acknowledgement" }, "retained_unknown"],
    [{ state: "success_reported" as const, providerRunId: "run_01" }, "retained_unknown"],
    [{ state: "cancellation_requested" as const, providerRunId: "run_01" }, "retained_unknown"],
  ])("keeps the money held for %j", async (outcome, state) => {
    const { registry, ledger } = seeded();
    const prepared = approved(
      await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000),
    );
    const id = prepared.reservation.reservationId;
    approved(ledger.markSubmitted(id, { providerRunId: "run_01" }, "exe_alpha", T0 + 1_100));
    const applied = approved(ledger.applyOutcome(id, outcome, "exe_alpha", T0 + 1_200));
    expect(applied.reservation.state).toBe(state);
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(4_000);
    expect(ledger.readBudget("own_alpha", "USD")?.settledMinorUnits).toBe(0);
  });

  it("settles only from an authoritative receipt, and then only up to the cap", async () => {
    const { registry, ledger } = seeded();
    const prepared = approved(
      await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000),
    );
    const id = prepared.reservation.reservationId;
    approved(ledger.markSubmitted(id, { providerRunId: "run_01" }, "exe_alpha", T0 + 1_100));
    // A receipt with no charged amount is not a settlement.
    expect(refusalCode(ledger.applyOutcome(id, { state: "receipt_captured", receiptRef: "rcp_01" }, "exe_alpha", T0 + 1_200))).toBe(
      "charge_amount_missing",
    );
    // More than the approved cap: retained, and named as a breach.
    expect(
      refusalCode(
        ledger.applyOutcome(
          id,
          { state: "receipt_verified", receiptRef: "rcp_01", chargedMinorUnits: 6_001 },
          "exe_alpha",
          T0 + 1_300,
        ),
      ),
    ).toBe("settled_amount_exceeds_reservation");
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(4_000);
    expect(ledger.readReservation(id)?.state).toBe("retained_unknown");

    const settled = approved(
      ledger.applyOutcome(
        id,
        { state: "receipt_verified", receiptRef: "rcp_01", chargedMinorUnits: 5_250 },
        "exe_alpha",
        T0 + 1_400,
      ),
    );
    expect(settled.reservation.state).toBe("settled");
    expect(settled.reservation.settledMinorUnits).toBe(5_250);
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(10_000 - 5_250);
    expect(ledger.unresolved("own_alpha")).toEqual([]);
  });

  it("keeps success reported, receipt captured and receipt verified distinct", async () => {
    const { registry, ledger } = seeded();
    const prepared = approved(
      await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000),
    );
    const id = prepared.reservation.reservationId;
    approved(ledger.markSubmitted(id, { providerRunId: "run_01" }, "exe_alpha", T0 + 1_100));
    // Reported, not captured: the money is still held.
    const reported = approved(ledger.applyOutcome(id, { state: "success_reported" }, "exe_alpha", T0 + 1_200));
    expect(reported.reservation.outcomeState).toBe("success_reported");
    expect(reported.reservation.state).toBe("retained_unknown");
    // Captured: a receipt exists, so the charge is authoritative and settles.
    const captured = approved(
      ledger.applyOutcome(id, { state: "receipt_captured", chargedMinorUnits: 5_000 }, "exe_alpha", T0 + 1_300),
    );
    expect(captured.reservation.outcomeState).toBe("receipt_captured");
    expect(captured.reservation.state).toBe("settled");
    // Verified: a stronger attestation of the SAME charge, not a second one.
    const verified = approved(
      ledger.applyOutcome(id, { state: "receipt_verified", chargedMinorUnits: 5_000 }, "exe_alpha", T0 + 1_400),
    );
    expect(verified.reservation.outcomeState).toBe("receipt_verified");
    expect(ledger.readBudget("own_alpha", "USD")?.settledMinorUnits).toBe(5_000);
  });

  it("refuses an out-of-order or restated outcome instead of un-knowing a receipt", async () => {
    const { registry, ledger } = seeded();
    const prepared = approved(
      await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000),
    );
    const id = prepared.reservation.reservationId;
    approved(ledger.markSubmitted(id, { providerRunId: "run_01" }, "exe_alpha", T0 + 1_100));
    approved(ledger.applyOutcome(id, { state: "receipt_verified", chargedMinorUnits: 5_000 }, "exe_alpha", T0 + 1_200));
    // A late "success reported" from a retried call must not erase the receipt.
    expect(refusalCode(ledger.applyOutcome(id, { state: "success_reported" }, "exe_alpha", T0 + 1_300))).toBe(
      "outcome_downgrade",
    );
    expect(ledger.readReservation(id)?.outcomeState).toBe("receipt_verified");
    // A repeated settlement cannot restate the amount.
    expect(
      refusalCode(
        ledger.applyOutcome(id, { state: "receipt_verified", chargedMinorUnits: 5_500 }, "exe_alpha", T0 + 1_400),
      ),
    ).toBe("outcome_downgrade");
    expect(ledger.readBudget("own_alpha", "USD")?.settledMinorUnits).toBe(5_000);
    // An exact duplicate attestation is a no-op, never a second charge.
    const duplicate = approved(
      ledger.applyOutcome(id, { state: "receipt_verified", chargedMinorUnits: 5_000 }, "exe_alpha", T0 + 1_500),
    );
    expect(duplicate.reservation.state).toBe("settled");
    expect(ledger.readBudget("own_alpha", "USD")?.settledMinorUnits).toBe(5_000);
    expect(refusalCode(ledger.applyOutcome("rsv_nope", { state: "success_reported" }, "exe_alpha", T0 + 1_600))).toBe(
      "reservation_not_found",
    );
    expect(refusalCode(ledger.applyOutcome(id, { state: "none" }, "exe_alpha", T0 + 1_700))).toBe("outcome_downgrade");
    expect(refusalCode(ledger.applyOutcome(id, { state: "receipt_captured", chargedMinorUnits: 5_000 }, "exe_alpha", T0 + 1_800))).toBe(
      "outcome_downgrade",
    );
  });

  it("refuses a late outcome that names a different provider run", async () => {
    const { registry, ledger } = seeded();
    const prepared = approved(
      await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000),
    );
    const id = prepared.reservation.reservationId;
    approved(ledger.markSubmitted(id, { providerRunId: "run_01" }, "exe_alpha", T0 + 1_100));
    expect(
      refusalCode(
        ledger.applyOutcome(id, { state: "receipt_captured", providerRunId: "run_99", chargedMinorUnits: 5_000 }, "exe_alpha", T0 + 1_200),
      ),
    ).toBe("outcome_downgrade");
  });

  it("lets at most one executor advance an intent", async () => {
    const { registry, ledger } = seeded();
    const prepared = approved(
      await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000),
    );
    const id = prepared.reservation.reservationId;
    expect(refusalCode(ledger.markSubmitted(id, { providerRunId: "run_01" }, "exe_beta", T0 + 1_100))).toBe("lease_not_held");
    // A stale executor lease does not become authority either.
    expect(refusalCode(ledger.markSubmitted(id, { providerRunId: "run_01" }, "exe_alpha", T0 + 90_000))).toBe("lease_not_held");
    expect(ledger.readReservation(id)?.submissionStarted).toBe(false);
  });

  it("does not treat a cancellation request as a refund, and records a failed refund distinctly", async () => {
    const { registry, ledger } = seeded();
    const prepared = approved(
      await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000),
    );
    const id = prepared.reservation.reservationId;
    approved(ledger.markSubmitted(id, { providerRunId: "run_01" }, "exe_alpha", T0 + 1_100));
    const cancelled = approved(ledger.applyOutcome(id, { state: "cancellation_requested" }, "exe_alpha", T0 + 1_200));
    expect(cancelled.reservation.cancellationRequestedAt).toBe(T0 + 1_200);
    expect(cancelled.reservation.refundState).toBe("not_requested");
    // Nothing authoritative followed the cancel, so the money stays held and
    // a refund cannot be claimed on the strength of a request.
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(4_000);
    expect(refusalCode(ledger.recordRefund(id, { state: "refund_recorded" }, T0 + 1_300))).toBe(
      "refund_requires_settlement",
    );

    approved(ledger.applyOutcome(id, { state: "receipt_captured", chargedMinorUnits: 5_000 }, "exe_alpha", T0 + 1_400));
    const failed = approved(ledger.recordRefund(id, { state: "refund_failed" }, T0 + 1_500));
    expect(failed.reservation.refundState).toBe("refund_failed");
    // A refund is its own fact and does not quietly hand budget back.
    expect(failed.budgetRestored).toBe(false);
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(5_000);
    const recorded = approved(ledger.recordRefund(id, { state: "refund_recorded", reference: "rfnd_01" }, T0 + 1_600));
    expect(recorded.reservation.refundState).toBe("refund_recorded");
    expect(ledger.availableMinorUnits("own_alpha", "USD")).toBe(5_000);
  });

  it("keeps a credential mint that bought nothing out of the purchase ledger", async () => {
    const { registry, ledger } = seeded();
    const prepared = approved(
      await prepareAgentPurchase(registry, ledger, SESSION, MAPPING, CAPABILITIES, baseRequest(), T0 + 1_000),
    );
    // Minting first: allowance is spent even though nothing was bought.
    const mint = approved(
      ledger.recordCredentialMint(
        { ownerId: "own_alpha", credentialRef: "crd_01", railAllowanceMinorUnits: 2_000 },
        T0 + 1_100,
      ),
    );
    expect(mint.reconciled).toBe(false);
    expect(ledger.unreconciledMints("own_alpha")).toHaveLength(1);
    expect(ledger.readBudget("own_alpha", "USD")?.settledMinorUnits).toBe(0);
    // A mint cannot ride on an unsettled purchase either.
    expect(
      refusalCode(
        ledger.recordCredentialMint(
          {
            ownerId: "own_alpha",
            credentialRef: "crd_02",
            railAllowanceMinorUnits: 2_000,
            purchaseReservationId: prepared.reservation.reservationId,
          },
          T0 + 1_200,
        ),
      ),
    ).toBe("credential_still_reconciling");
    approved(
      ledger.applyOutcome(
        prepared.reservation.reservationId,
        { state: "receipt_captured", chargedMinorUnits: 5_000 },
        "exe_alpha",
        T0 + 1_300,
      ),
    );
    const settledMint = approved(
      ledger.recordCredentialMint(
        {
          ownerId: "own_alpha",
          credentialRef: "crd_02",
          railAllowanceMinorUnits: 2_000,
          purchaseReservationId: prepared.reservation.reservationId,
        },
        T0 + 1_400,
      ),
    );
    expect(settledMint.reconciled).toBe(true);
    expect(ledger.unreconciledMints("own_alpha").map((row) => row.credentialRef)).toEqual(["crd_01"]);
  });
});

// ── wallet scopes ──────────────────────────────────────────────────────

const RECIPIENT = "0x1111111111111111111111111111111111111111";

/** The untrusted wallet-scope field bag, typed field by field so the
 * boundary types stay honest. */
interface ScopeOverride {
  scopeId?: unknown;
  ownerId?: unknown;
  chain?: unknown;
  contract?: unknown;
  decimals?: unknown;
  symbol?: unknown;
  maxAmountMinorUnits?: unknown;
  recipients?: unknown;
  expiresAt?: unknown;
}

const scopeInput = (overrides: ScopeOverride = {}) => ({
  scopeId: "scp_alpha",
  ownerId: "own_alpha",
  chain: "base",
  contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  decimals: 6,
  symbol: "USDC",
  maxAmountMinorUnits: 25_000,
  recipients: [RECIPIENT],
  expiresAt: T0 + 600_000,
  ...overrides,
});

const scopeFrom = (overrides: ScopeOverride = {}): AgentWalletScope => {
  const decision = parseAgentWalletScope(scopeInput(overrides), T0);
  if (decision.outcome === "refused") throw new Error(decision.reason);
  return decision.scope;
};

describe("wallet scopes are explicit and fail closed", () => {
  it("refuses an empty or omitted recipient allowlist instead of defaulting it", () => {
    expect(refusalCode(parseAgentWalletScope(scopeInput({ recipients: [] }), T0))).toBe("scope_recipients_empty");
    expect(refusalCode(parseAgentWalletScope(scopeInput({ recipients: undefined }), T0))).toBe("scope_recipients_empty");
    expect(refusalCode(parseAgentWalletScope(scopeInput({ recipients: "all" }), T0))).toBe("scope_recipients_empty");
  });

  it("refuses a wildcard recipient and a duplicate allowlist entry", () => {
    expect(refusalCode(parseAgentWalletScope(scopeInput({ recipients: ["*"] }), T0))).toBe("scope_wildcard_forbidden");
    expect(
      refusalCode(parseAgentWalletScope(scopeInput({ recipients: [RECIPIENT, RECIPIENT.toLowerCase()] }), T0)),
    ).toBe("scope_wildcard_forbidden");
    expect(refusalCode(parseAgentWalletScope(scopeInput({ recipients: ["not-an-address"] }), T0))).toBe(
      "scope_wildcard_forbidden",
    );
  });

  it("refuses a missing cap and an expired scope", () => {
    expect(refusalCode(parseAgentWalletScope(scopeInput({ maxAmountMinorUnits: undefined }), T0))).toBe(
      "scope_amount_missing",
    );
    expect(refusalCode(parseAgentWalletScope(scopeInput({ maxAmountMinorUnits: 0 }), T0))).toBe("scope_amount_missing");
    expect(refusalCode(parseAgentWalletScope(scopeInput({ maxAmountMinorUnits: 1.5 }), T0))).toBe("scope_amount_missing");
    expect(refusalCode(parseAgentWalletScope(scopeInput({ expiresAt: T0 - 1 }), T0))).toBe("scope_expired");
    expect(refusalCode(parseAgentWalletScope(scopeInput(), T0 + 600_000))).toBe("scope_expired");
  });

  it("refuses an unrecognised chain or token, and unproven decimals", () => {
    expect(refusalCode(parseAgentWalletScope(scopeInput({ chain: "dogecoin" }), T0))).toBe("unknown_chain");
    expect(refusalCode(parseAgentWalletScope(scopeInput({ contract: "0xdead" }), T0))).toBe("unknown_asset");
    expect(refusalCode(parseAgentWalletScope(scopeInput({ decimals: 18 }), T0))).toBe("amount_decimals_unproven");
    // The typed resolvers say exactly which check failed.
    expect(() => resolveAgentTokenAsset("dogecoin", RECIPIENT)).toThrow(
      expect.objectContaining({ code: "unknown_chain" }),
    );
    expect(() => resolveAgentTokenAsset("base", "0xdead")).toThrow(expect.objectContaining({ code: "unknown_asset" }));
    expect(() =>
      assertRegisteredTokenAsset({
        chain: "base",
        contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 18,
        symbol: "USDC",
      }),
    ).toThrow(expect.objectContaining({ code: "amount_decimals_unproven" }));
  });

  it("treats a display symbol as no identity at all", () => {
    // USDC on ethereum and USDC on base are different assets, and the symbol
    // matches in both cases.
    const ethereum: AgentTokenAsset = {
      chain: "ethereum",
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
      symbol: "USDC",
    };
    expect(ethereum.symbol).toBe(scopeInput().symbol);
    expect(resolveAgentTokenAsset("ethereum", ethereum.contract).chain).toBe("ethereum");
    expect(() => resolveAgentTokenAsset("polygon", ethereum.contract)).toThrow(
      expect.objectContaining({ code: "unknown_asset" }),
    );
    expect(AGENT_TOKEN_CHAINS).not.toContain("dogecoin");
  });

  it("authorizes only a proven plain transfer inside the scope", () => {
    const scope = scopeFrom();
    const decision = authorizeAgentWalletOperation(scope, {
      ownerId: "own_alpha",
      operation: "transfer",
      chain: "base",
      contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      recipient: RECIPIENT.toLowerCase(),
      amountMinorUnits: 25_000,
      now: T0 + 1_000,
    });
    expect(approved(decision).amountMinorUnits).toBe(25_000);
    expect([...AGENT_WALLET_PROVEN_OPERATIONS]).toEqual(["transfer"]);
  });

  it.each(["swap", "bridge", "contract_call", "typed_data", "sign_message"] as const)(
    "refuses %s even inside a valid transfer scope",
    (operation) => {
      const decision = authorizeAgentWalletOperation(scopeFrom(), {
        ownerId: "own_alpha",
        operation,
        chain: "base",
        contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        recipient: RECIPIENT,
        amountMinorUnits: 1_000,
        now: T0 + 1_000,
      });
      expect(refusalCode(decision)).toBe("scope_operation_not_proven");
    },
  );

  it("refuses a recipient outside the allowlist, a chain or token switch, and an over-cap amount", () => {
    const scope = scopeFrom();
    const base = {
      ownerId: "own_alpha",
      operation: "transfer" as const,
      chain: "base",
      contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      recipient: RECIPIENT,
      amountMinorUnits: 1_000,
      now: T0 + 1_000,
    };
    expect(
      refusalCode(authorizeAgentWalletOperation(scope, { ...base, recipient: "0x2222222222222222222222222222222222222222" })),
    ).toBe("scope_recipient_not_allowed");
    expect(
      refusalCode(
        authorizeAgentWalletOperation(scope, {
          ...base,
          chain: "polygon",
          contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        }),
      ),
    ).toBe("asset_changed");
    expect(refusalCode(authorizeAgentWalletOperation(scope, { ...base, amountMinorUnits: 25_001 }))).toBe("cap_exceeded");
    expect(refusalCode(authorizeAgentWalletOperation(scope, { ...base, amountMinorUnits: 1_000.5 }))).toBe(
      "scope_amount_missing",
    );
    expect(refusalCode(authorizeAgentWalletOperation(scope, { ...base, ownerId: "own_beta" }))).toBe("owner_mismatch");
    expect(refusalCode(authorizeAgentWalletOperation(scope, { ...base, now: T0 + 600_000 }))).toBe("scope_expired");
  });
});

// ── paid calls: no global auto-paying fetch ────────────────────────────

const CONSENT: AgentPaidCallConsent = {
  consentId: "cns_01",
  ownerId: "own_alpha",
  origin: "https://api.example",
  payee: "pay_dataprovider",
  asset: { chain: "base", contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" },
  maxAmountMinorUnits: 1_000,
  expiresAt: T0 + 600_000,
};

const paidCall = (overrides: Partial<AgentPaidCallRequest> = {}): AgentPaidCallRequest => ({
  ownerId: "own_alpha",
  url: "https://api.example/v1/answer",
  payee: "pay_dataprovider",
  chain: "base",
  contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amountMinorUnits: 250,
  scheme: "x402",
  redirect: "manual",
  now: T0 + 1_000,
  ...overrides,
});

describe("a paid HTTP call can only be offered to a human", () => {
  it("authorizes only as an explicit user confirmation, with nothing to pay through", () => {
    const decision = approved(authorizeAgentPaidCall(CONSENT, paidCall()));
    expect(decision.requiresUserConfirmation).toBe(true);
    for (const forbidden of ["headers", "authorization", "retry", "payment", "signature", "autoRetry"]) {
      expect(Object.hasOwn(decision, forbidden)).toBe(false);
    }
  });

  it.each([
    [{ scheme: "none" as const }, "auto_pay_not_permitted"],
    [{ redirect: "follow" as const }, "auto_pay_redirect_forbidden"],
    [{ redirect: "error" as const }, "auto_pay_redirect_forbidden"],
    [{ url: "https://evil.example/v1/answer" }, "auto_pay_endpoint_not_pinned"],
    [{ url: "/v1/answer" }, "auto_pay_endpoint_not_pinned"],
    [{ payee: "pay_attacker" }, "payee_changed"],
    [{ chain: "polygon", contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" }, "auto_pay_network_mismatch"],
    [{ amountMinorUnits: 1_001 }, "cap_exceeded"],
    [{ amountMinorUnits: 0 }, "scope_amount_missing"],
    [{ now: T0 + 600_000 }, "auto_pay_consent_expired"],
    [{ ownerId: "own_beta" }, "owner_mismatch"],
  ] as const)("refuses a challenge with %j", (overrides, code) => {
    expect(refusalCode(authorizeAgentPaidCall(CONSENT, paidCall(overrides)))).toBe(code);
  });
});

// ── credential hygiene ─────────────────────────────────────────────────

describe("card data, passwords and keys stay out of payloads", () => {
  it.each([
    { label: "cardNumber", text: "4111111111111111" },
    { label: "card_number", text: "x" },
    { label: "CVV", text: "123" },
    { label: "security_code", text: "123" },
    { label: "merchant_password", text: "hunter2" },
    { label: "private_key", text: "0xabc" },
    { label: "seed_phrase", text: "olympic" },
    { label: "mnemonic", text: "olympic" },
    { label: "signing_key", text: "0xabc" },
    { label: "note", text: "4111 1111 1111 1111" },
  ])("refuses the field %j", (field) => {
    expect(refusalCode(assertNoSensitivePaymentMaterial([field]))).toBe("sensitive_material_in_payload");
  });

  it("allows ordinary purchase fields through", () => {
    const decision = assertNoSensitivePaymentMaterial([
      { label: "merchant", text: "Bookseller" },
      { label: "item", text: "Hardcover, 1 copy" },
      { label: "total", text: "50.00 USD" },
      { label: "payment_method", text: "pm_mockcard_01" },
    ]);
    expect(decision).toEqual({ outcome: "authorized", fields: 4 });
  });

  it("recognises card numbers in the shapes people actually paste", () => {
    expect(looksLikeCardNumber("4242424242424242")).toBe(true);
    expect(looksLikeCardNumber("4242 4242 4242 4242")).toBe(true);
    expect(looksLikeCardNumber("4242-4242-4242-4242")).toBe(true);
    expect(looksLikeCardNumber("4242424242424241")).toBe(false);
    expect(looksLikeCardNumber("pm_mockcard_01")).toBe(false);
    expect(isOpaquePaymentMethodRef("pm_mockcard_01")).toBe(true);
    expect(isOpaquePaymentMethodRef("4242424242424242")).toBe(false);
    expect(isOpaquePaymentMethodRef("my card")).toBe(false);
  });

  it("refuses to build an approval around a raw card number", () => {
    expect(() => createAgentPurchaseApproval(baseApproval({ paymentMethodRef: "4242424242424242" }))).toThrow(
      expect.objectContaining({ code: "payment_method_not_opaque" }),
    );
  });
});

// ── wire boundary ──────────────────────────────────────────────────────

describe("the wire request is decoded at its boundary", () => {
  it("refuses a malformed body before any policy rule sees it", () => {
    expect(refusalCode(parseAgentPurchaseRequest({ approvalId: "ap_book_01" }))).toBe("amount_not_integer_minor_units");
    expect(refusalCode(parseAgentPurchaseRequest({ ...baseRequest(), amountMinorUnits: "5000" }))).toBe(
      "amount_not_integer_minor_units",
    );
    expect(refusalCode(parseAgentPurchaseRequest({ ...baseRequest(), recurring: "yes" }))).toBe(
      "amount_not_integer_minor_units",
    );
  });

  it("refuses an unknown rail from the wire", () => {
    expect(refusalCode(parseAgentPurchaseRequest({ ...baseRequest(), rail: "carrier_pigeon" }))).toBe("rail_not_permitted");
  });

  it("decodes a well-formed body into the domain request", () => {
    const parsed = approved(parseAgentPurchaseRequest(baseRequest()));
    expect(parsed.request.rail).toBe("visa_intelligent_commerce");
    expect(parsed.request.amountMinorUnits).toBe(5_000);
  });
});

// ── authority lifecycle ────────────────────────────────────────────────

describe("deleting a method, revoking an allowance and revoking a signer are three operations", () => {
  const authority = (): AgentPaymentAuthority => ({
    ownerId: "own_alpha",
    boundDeviceId: "dev_alpha",
    paymentMethods: ["pm_mockcard_01"],
    mintedCredentials: ["crd_01"],
    signers: ["sgn_01"],
    dispatchBlocked: false,
  });

  const outstanding = [
    { approvalId: "ap_book_01", revision: 1, paymentMethodRef: "pm_mockcard_01" },
    { approvalId: "ap_box_02", revision: 3, paymentMethodRef: "pm_mockcard_02" },
  ];

  it("deletes a payment method without cancelling the intents it funded", () => {
    const state = authority();
    const receipt = approved(
      revokeAgentPaymentAuthority(state, { kind: "payment_method", reference: "pm_mockcard_01" }, outstanding, ["crd_01"], T0),
    );
    expect(receipt.receipt.kind).toBe("payment_method");
    expect(state.paymentMethods).toEqual([]);
    // Mint/revoke are separate effects: the credential and the signer survive.
    expect(state.mintedCredentials).toEqual(["crd_01"]);
    expect(state.signers).toEqual(["sgn_01"]);
    // The approval it funded is reported as still outstanding, not cancelled.
    expect(receipt.receipt.outstandingApprovals).toEqual(["ap_book_01#1"]);
    expect(refusalCode(revokeAgentPaymentAuthority(state, { kind: "payment_method", reference: "pm_mockcard_01" }, outstanding, [], T0))).toBe(
      "payment_method_not_found",
    );
  });

  it("revokes a minted credential and surfaces the allowance it may have spent", () => {
    const state = authority();
    const receipt = approved(
      revokeAgentPaymentAuthority(state, { kind: "minted_credential", reference: "crd_01" }, outstanding, ["crd_01"], T0),
    );
    expect(receipt.receipt.unreconciledMints).toEqual(["crd_01"]);
    expect(state.mintedCredentials).toEqual([]);
    expect(state.paymentMethods).toEqual(["pm_mockcard_01"]);
    expect(refusalCode(revokeAgentPaymentAuthority(state, { kind: "minted_credential", reference: "crd_zz" }, outstanding, [], T0))).toBe(
      "credential_not_found",
    );
  });

  it("revokes a wallet signer without touching card state", () => {
    const state = authority();
    const receipt = approved(
      revokeAgentPaymentAuthority(state, { kind: "wallet_signer", reference: "sgn_01" }, outstanding, [], T0),
    );
    expect(receipt.receipt.kind).toBe("wallet_signer");
    expect(state.signers).toEqual([]);
    expect(state.paymentMethods).toEqual(["pm_mockcard_01"]);
    expect(receipt.receipt.outstandingApprovals).toEqual([]);
    expect(refusalCode(revokeAgentPaymentAuthority(state, { kind: "wallet_signer", reference: "sgn_zz" }, outstanding, [], T0))).toBe(
      "signer_not_found",
    );
  });

  it("blocks dispatch first, then reports what is still unresolved", () => {
    const state = authority();
    const receipt = approved(disconnectAgentPayments(state, outstanding, ["rev_pending_01"], T0));
    expect(receipt.receipt.dispatchBlocked).toBe(true);
    expect(state.dispatchBlocked).toBe(true);
    expect(receipt.receipt.outstandingApprovals).toEqual(["ap_book_01#1", "ap_box_02#3"]);
    expect(receipt.receipt.unconfirmed).toEqual(["rev_pending_01"]);
    // A revocation that was requested is not a revocation that happened.
    expect(refusalCode(assertAgentRevocationsConfirmed(receipt.receipt))).toBe("unconfirmed_revocation");
    expect(refusalCode(disconnectAgentPayments(state, outstanding, [], T0 + 1))).toBe("dispatch_already_blocked");
  });

  it("restores no payment permission after sign-out, a device swap or a workspace restore", () => {
    const state = authority();
    const restored = approved(restoreAgentPaymentAuthority(state, { signedIn: true, deviceId: "dev_alpha" }, ["rsv_1"], T0));
    expect(restored.reconnected).toEqual([]);
    expect(restored.authority.paymentMethods).toEqual([]);
    expect(restored.authority.mintedCredentials).toEqual([]);
    expect(restored.authority.signers).toEqual([]);
    // Only the identity of unresolved money survives.
    expect(restored.preservedReservations).toEqual(["rsv_1"]);
    expect(refusalCode(restoreAgentPaymentAuthority(state, { signedIn: false, deviceId: "dev_alpha" }, [], T0))).toBe(
      "not_authenticated",
    );
    expect(refusalCode(restoreAgentPaymentAuthority(state, { signedIn: true, deviceId: "dev_replacement" }, [], T0))).toBe(
      "device_replaced",
    );
  });
});

// ── the module is inert ────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const moduleSource = readFileSync(join(here, "agent-payment-policy.ts"), "utf8");

const sourceFilesUnder = (root: string): readonly string[] => {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === "node_modules" || entry === "build" || entry === "dist") continue;
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|cjs)$/.test(entry)) found.push(full);
    }
  };
  walk(resolve(root));
  return found;
};

describe("the C0 module performs no effects and is wired to nothing", () => {
  it("contains no network, credential or timing call", () => {
    for (const forbidden of [
      /\bfetch\s*\(/,
      /XMLHttpRequest/,
      /WebSocket/,
      /node:https?/,
      /require\s*\(/,
      /process\.env/,
      /\bsetTimeout\b/,
      /\bsetInterval\b/,
      /Date\.now/,
      /Math\.random/,
      /Bun\.|Deno\./,
    ]) {
      expect(moduleSource).not.toMatch(forbidden);
    }
    // The only dependency is a pure validation library.
    const imports = moduleSource.match(/^import .*$/gm) ?? [];
    expect(imports).toHaveLength(1);
    expect(imports[0]).toBe('import { z } from "zod";');
  });

  it("is imported by no other server or web source file", () => {
    const offenders = sourceFilesUnder(join(here, ".."))
      .concat(sourceFilesUnder(join(here, "..", "src")))
      .filter((file) => !file.endsWith("agent-payment-policy.test.ts"))
      .filter((file) => readFileSync(file, "utf8").includes("agent-payment-policy"));
    expect(offenders).toEqual([]);
  });

  it("does not reach into subscription billing", () => {
    // The module may NAME billing to explain the separation, but it must not
    // import it, and billing must not import it either.
    expect(moduleSource).not.toMatch(/^import .*billing/m);
    expect(readFileSync(join(here, "billing.ts"), "utf8")).toContain("subscription");
    expect(readFileSync(join(here, "billing.ts"), "utf8")).not.toContain("agent-payment-policy");
  });
});
