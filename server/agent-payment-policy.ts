// Optional agent payments — the C0 policy/accounting/identity contract.
//
// SCOPE (slice C0 of docs/plans/crossmint-agent-payments-plan-2026-09-29.md):
// this module is a DETERMINISTIC, MOCK-ONLY contract of refusals plus a
// ledger. It installs no SDK, opens no socket, reads no credential, holds no
// key and moves no money. There is no provider adapter here, no card, no
// wallet, no `fetch` and no "simulated" network call of any kind — the
// provider identities it reasons about are opaque strings from owned fixtures.
// Nothing imports it yet, so the slice's rollback is deleting this file.
//
// It is NOT a connected payment feature, and nothing in it is evidence that
// any vendor documentation certifies Muster. What it does claim is narrower:
// given a set of claims, it decides which ones are refusable, and it keeps an
// honest ledger of money it has promised to hold.
//
// Constraints encoded here, and where:
//   * Derived authority — `deriveAgentPaymentBuyer` takes the buyer id from an
//     authenticated owner→buyer mapping; a client/model-supplied id that does
//     not match is refused, and a missing subject has no project-wide default.
//   * Exact purchase approvals — `AgentPurchaseApproval` records owner, task,
//     device, provider/buyer, opaque payment method, rail, payee, item digest,
//     exact amount AND cap in integer minor units, currency, expiry and
//     approval revision. A change to any of those needs a new revision.
//   * Cap, not quote — `prepareAgentPurchase` reserves the approved CAP, so
//     the authoritative charge can never exceed what the owner approved.
//   * Reserve before effects, settle from authority — the ledger
//     synchronously takes the budget, then an authoritative receipt settles
//     it. While the outcome is unknown the reservation is RETAINED; a timeout
//     is not evidence that nothing happened.
//   * Distinct outcomes — reported / captured / verified / unknown / cancel
//     requested are five different states with a one-way ladder. A
//     cancellation request is NOT a refund and moves no budget.
//   * Money is integers — every amount is integer minor units; the one
//     decimal entry point is a string parser. No binary float touches money.
//   * Rails fail closed — the encrypted-card fallback is named in the rail
//     union only so it can be refused by name. It is never permitted, never
//     auto-selected, and never substituted for by a different rail.
//   * Wallet scopes are explicit — token, chain, decimals, cap, NONEMPTY
//     recipient allowlist and expiry. There is no wildcard member in the type
//     and no default scope, and only `transfer` is a proven operation.
//   * No global auto-paying fetch — `authorizeAgentPaidCall` can only return
//     "requires_user_confirmation"; there is no code path here that signs,
//     retries or pays anything.
//
// Purchase budgets in this file are SEPARATE from Muster subscription billing
// (`server/billing.ts`) and from model-usage accounting. Nothing here reads or
// writes either of those, and `ownerId` here is an account/workspace id, not a
// subscription. `setLimit` is a local mock, not a subscription mutation.

import { z } from "zod";

/** Wire version of this policy contract. Bump only when an existing
 * consumer's meaning changes; C0 has no consumers yet. */
export const AGENT_PAYMENT_POLICY_VERSION = 1;

// ── decisions ──────────────────────────────────────────────────────────

/** Every refusal in this module is one of these codes. A refusal is the
 * normal outcome: a purchase that is not provably inside an approval is
 * refused, and the reason is machine-readable rather than a free-text
 * excuse. */
export type AgentPaymentDenialCode =
  // asset / money
  | "unknown_currency"
  | "unknown_asset"
  | "unknown_chain"
  | "amount_not_integer_minor_units"
  | "amount_decimals_unproven"
  | "negative_amount"
  | "currency_changed"
  | "amount_changed"
  | "cap_exceeded"
  | "charge_amount_missing"
  | "item_changed"
  | "asset_changed"
  | "payee_changed"
  | "payment_method_changed"
  | "recurrence_added"
  // authority
  | "owner_mismatch"
  | "buyer_not_derived"
  | "subject_missing"
  | "task_mismatch"
  | "device_mismatch"
  | "project_environment_mismatch"
  | "approval_not_found"
  | "approval_expired"
  | "approval_superseded"
  | "approval_already_consumed"
  // rails and capabilities
  | "rail_not_permitted"
  | "rail_fallback_forbidden"
  | "capability_not_verified"
  // budget
  | "budget_not_configured"
  | "budget_limit_below_committed"
  | "budget_exhausted"
  | "reservation_not_found"
  | "reservation_already_settled"
  | "reservation_voided"
  | "outcome_unknown"
  | "settled_amount_exceeds_reservation"
  | "outcome_downgrade"
  | "lease_not_held"
  | "refund_requires_settlement"
  | "credential_not_found"
  | "credential_still_reconciling"
  // wallet scopes
  | "scope_recipients_empty"
  | "scope_incomplete"
  | "scope_wildcard_forbidden"
  | "scope_amount_missing"
  | "scope_expired"
  | "scope_operation_not_proven"
  | "scope_recipient_not_allowed"
  // paid calls
  | "auto_pay_not_permitted"
  | "auto_pay_endpoint_not_pinned"
  | "auto_pay_network_mismatch"
  | "auto_pay_redirect_forbidden"
  | "auto_pay_consent_expired"
  // credential hygiene
  | "sensitive_material_in_payload"
  | "payment_method_not_opaque"
  | "payment_method_not_found"
  | "signer_not_found"
  | "unconfirmed_revocation"
  | "dispatch_already_blocked"
  | "not_authenticated"
  | "device_replaced";

export class AgentPaymentPolicyError extends Error {
  readonly code: AgentPaymentDenialCode;

  constructor(code: AgentPaymentDenialCode, message: string) {
    super(message);
    this.name = "AgentPaymentPolicyError";
    this.code = code;
  }
}

export interface AgentPaymentRefusal {
  outcome: "refused";
  code: AgentPaymentDenialCode;
  reason: string;
}

/** The only two shapes any policy function in this file returns. There is no
 * third "maybe it worked" branch. */
export type AgentPaymentDecision<T> = ({ outcome: "authorized" } & T) | AgentPaymentRefusal;

function refuse(code: AgentPaymentDenialCode, reason: string): AgentPaymentRefusal {
  return { outcome: "refused", code, reason };
}

// ── money: integer minor units, never binary floating point ────────────

/** Minor-unit exponent per recognised currency: how many minor units make one
 * major unit. A currency that is not in this table is refused rather than
 * assumed to have two decimals — guessing an exponent is how a cap silently
 * becomes 100x too large or too small. */
const FIAT_MINOR_UNIT_EXPONENTS = new Map<string, number>([
  ["USD", 2], ["EUR", 2], ["GBP", 2], ["CAD", 2], ["AUD", 2], ["NZD", 2], ["CHF", 2], ["SEK", 2],
  ["JPY", 0], ["KRW", 0],
  ["BHD", 3], ["KWD", 3], ["OMR", 3], ["TND", 3], ["JOD", 3],
]);

/** One exact amount. `minorUnits` is the only money number in this module:
 * an integer count of the currency's smallest unit. */
export interface AgentPaymentAmount {
  currency: string;
  minorUnits: number;
}

export function isKnownAgentPaymentCurrency(currency: string): boolean {
  return FIAT_MINOR_UNIT_EXPONENTS.has(currency);
}

/** The minor-unit exponent of a recognised currency. */
export function agentPaymentMinorUnitExponent(currency: string): number {
  const exponent = FIAT_MINOR_UNIT_EXPONENTS.get(currency);
  if (exponent === undefined) {
    throw new AgentPaymentPolicyError(
      "unknown_currency",
      `${currency} is not in the recognised fiat table; add its exponent explicitly instead of guessing`,
    );
  }
  return exponent;
}

/** Guard for every amount that crosses a boundary. Rejects a fractional or
 * out-of-range number outright — it is never rounded, because rounding a cap
 * upward is an unauthorised spend. */
function requireIntegerMinorUnits(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new AgentPaymentPolicyError(
      "amount_not_integer_minor_units",
      `${field} must be a safe integer count of minor units; binary floating point is not money`,
    );
  }
  if (value < 0) {
    throw new AgentPaymentPolicyError("negative_amount", `${field} must not be negative`);
  }
  return value;
}

/** The only validated-decimal entry point: a decimal STRING in, an exact
 * integer count out. Exponent notation, signs, spaces, thousands separators,
 * an empty integer part and excess precision are all refused rather than
 * rounded or coerced. `10.07` is 1007, not 1006.9999999999999. */
export function parseAgentPaymentDecimal(value: string, currency: string): AgentPaymentAmount {
  const exponent = agentPaymentMinorUnitExponent(currency);
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value);
  if (match === null) {
    throw new AgentPaymentPolicyError(
      "amount_not_integer_minor_units",
      `${value} is not a plain non-negative decimal string`,
    );
  }
  const [, major, fraction = ""] = match;
  if (fraction.length > exponent) {
    throw new AgentPaymentPolicyError(
      "amount_not_integer_minor_units",
      `${value} has more precision than ${currency}'s ${exponent} minor units can hold`,
    );
  }
  // BigInt carries the whole value exactly; the safe-integer check below is
  // what keeps the conversion to `number` lossless.
  const scaled = BigInt(`${major}${fraction.padEnd(exponent, "0")}`);
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AgentPaymentPolicyError(
      "amount_not_integer_minor_units",
      `${value} in ${currency} exceeds the safe integer range of minor units`,
    );
  }
  return { currency, minorUnits: Number(scaled) };
}

/** Exact decimal rendering of a minor-unit amount, computed in BigInt so no
 * float division rounds the wrong way. */
export function formatAgentPaymentAmount(amount: AgentPaymentAmount): string {
  const exponent = agentPaymentMinorUnitExponent(amount.currency);
  const units = BigInt(requireIntegerMinorUnits(amount.minorUnits, "amount.minorUnits"));
  if (exponent === 0) return units.toString();
  const padded = units.toString().padStart(exponent + 1, "0");
  return `${padded.slice(0, -exponent)}.${padded.slice(-exponent)}`;
}

/** Fiat + token amounts are compared by exact integer total in one currency. */
export function agentPaymentAmountsEqual(left: AgentPaymentAmount, right: AgentPaymentAmount): boolean {
  return left.currency === right.currency && left.minorUnits === right.minorUnits;
}

// ── tokens: identity is chain + contract, never a display symbol ───────

export const AGENT_TOKEN_CHAINS = [
  "ethereum",
  "base",
  "polygon",
  "arbitrum",
  "optimism",
  "solana",
] as const;

export type AgentTokenChain = (typeof AGENT_TOKEN_CHAINS)[number];

/** A token's identity. `contract` is what makes it the same asset; `symbol`
 * is display only and is never used for comparison, because one symbol maps
 * to many different contracts across chains. */
export interface AgentTokenAsset {
  chain: AgentTokenChain;
  contract: string;
  decimals: number;
  symbol: string;
}

/** The chains C0 recognises. A chain outside this set fails closed: the
 * enforcement path for an unrecognised chain has not been looked at. */
const KNOWN_TOKEN_CHAINS = new Set<string>(AGENT_TOKEN_CHAINS);

/** The tokens C0 recognises, keyed by `chain:contract`. There is no
 * "whatever the display symbol says" lookup. */
const KNOWN_TOKEN_ASSETS = new Map<string, AgentTokenAsset>([
  ["ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", { chain: "ethereum", contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" }],
  ["polygon:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", { chain: "polygon", contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, symbol: "USDC" }],
  ["base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", { chain: "base", contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" }],
  ["base:0x4200000000000000000000000000000000000006", { chain: "base", contract: "0x4200000000000000000000000000000000000006", decimals: 18, symbol: "WETH" }],
  ["solana:epjfwd5aufqssqem2qn1xzybapc8g4weggzxwytdt1v", { chain: "solana", contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, symbol: "USDC" }],
]);

function agentTokenAssetKey(chain: string, contract: string): string {
  return `${chain}:${contract.trim().toLowerCase()}`;
}

/** Resolve a token to a registered asset, or refuse. A chain or contract
 * outside the registry is unknown, not "probably fine". */
export function resolveAgentTokenAsset(chain: string, contract: string): AgentTokenAsset {
  if (!KNOWN_TOKEN_CHAINS.has(chain)) {
    throw new AgentPaymentPolicyError("unknown_chain", `chain ${chain} is not in the recognised chain set`);
  }
  const asset = KNOWN_TOKEN_ASSETS.get(agentTokenAssetKey(chain, contract));
  if (asset === undefined) {
    throw new AgentPaymentPolicyError("unknown_asset", `no registered token ${chain}:${contract}`);
  }
  return asset;
}

/** A caller-declared asset only counts when it names the same chain, the same
 * contract AND the same decimals the registry holds. A wrong `decimals` is
 * its own refusal: it is the difference between 1 USDC and 10^12 of it. */
export function assertRegisteredTokenAsset(asset: AgentTokenAsset): AgentTokenAsset {
  const registered = resolveAgentTokenAsset(asset.chain, asset.contract);
  if (registered.decimals !== asset.decimals) {
    throw new AgentPaymentPolicyError(
      "amount_decimals_unproven",
      `${asset.symbol} on ${asset.chain} has ${registered.decimals} decimals, not ${asset.decimals}`,
    );
  }
  return registered;
}

// ── rails: the allowlist is the whole policy ───────────────────────────

export type AgentPaymentRail =
  | "visa_intelligent_commerce"
  | "mastercard_agent_pay"
  /** Excluded: this fallback encrypts the saved card to the agent's key and
   * leans on the app's own allowance handling, so a cap on it is a request,
   * not an enforcement. It is in the union ONLY so callers can be refused by
   * name. It is never permitted and never selected automatically. */
  | "encrypted_card_fallback"
  | "provider_checkout"
  | "wallet_transfer"
  | "x402_http_challenge"
  | "mpp_evm";

/** Rails C0 permits. Membership is a deliberate list, not a negation: a rail
 * added here is a claim someone has checked, and the encrypted-card fallback
 * is not on it. */
export const AGENT_PAYMENT_PERMITTED_RAILS: ReadonlySet<AgentPaymentRail> = new Set<AgentPaymentRail>([
  "visa_intelligent_commerce",
  "mastercard_agent_pay",
  "provider_checkout",
]);

/** What an owner-controlled check actually established about one rail. Every
 * field is negative-by-default evidence: a rail nobody checked reports
 * `enforcementVerified: false` and is therefore refused. */
export interface AgentRailCapability {
  rail: AgentPaymentRail;
  /** Someone verified that this rail enforces the approved cap for THIS
   * operation at the network/provider layer, for the actual path used. An
   * overview-level promise is not this evidence. */
  enforcementVerified: boolean;
  /** What the merchant/provider actually supports right now — observed, never
   * assumed from a general capability list. */
  supportObserved: boolean;
  /** Card eligibility is a property of the card, not of the owner's address. */
  cardEligible?: boolean;
}

/** A merchant product C0 can be pointed at. Fictional fixtures only; nothing
 * here resolves or contacts a host. */
export interface AgentMerchantOffer {
  /** Exact origin the approval is bound to. Scheme + host + port, no paths. */
  origin: string;
  merchantName: string;
  payee: string;
  /** Human-readable item description that goes into the digest. */
  item: string;
  quantity: number;
}

const CARD_RAILS: ReadonlySet<AgentPaymentRail> = new Set<AgentPaymentRail>([
  "visa_intelligent_commerce",
  "mastercard_agent_pay",
  "encrypted_card_fallback",
]);

export function isAgentCardRail(rail: AgentPaymentRail): boolean {
  return CARD_RAILS.has(rail);
}

/** A purchase approval can only be bound to a rail that is already permitted.
 * There is therefore no approval to construct for the encrypted-card
 * fallback, for a paid-call rail or for a wallet transfer — wallet spending
 * goes through an explicit `AgentWalletScope` instead, and paid calls through
 * an explicit `AgentPaidCallConsent`. */
const isPermittedApprovalRail = (rail: AgentPaymentRail): boolean => AGENT_PAYMENT_PERMITTED_RAILS.has(rail);

/** Refuse a rail, or confirm the exact one that was asked for. This function
 * NEVER returns a different rail: a merchant that supports Visa but not
 * Mastercard is a changed purchase, which needs a new approval, not a quiet
 * substitution. */
export function selectAgentPaymentRail(
  requested: AgentPaymentRail,
  capabilities: readonly AgentRailCapability[],
): AgentPaymentDecision<{ rail: AgentPaymentRail; capability: AgentRailCapability }> {
  if (requested === "encrypted_card_fallback") {
    return refuse(
      "rail_fallback_forbidden",
      "the encrypted-card fallback is excluded: its cap is an app-side request, not a network-enforced limit",
    );
  }
  if (!AGENT_PAYMENT_PERMITTED_RAILS.has(requested)) {
    return refuse("rail_not_permitted", `rail ${requested} is not in the C0 permitted set`);
  }
  const capability = capabilities.find((entry) => entry.rail === requested);
  if (capability === undefined) {
    return refuse("capability_not_verified", `no capability record for ${requested}; fail closed`);
  }
  if (!capability.enforcementVerified) {
    return refuse("capability_not_verified", `${requested} has no verified cap enforcement for this operation`);
  }
  if (!capability.supportObserved) {
    return refuse("capability_not_verified", `${requested} support was never observed for this merchant`);
  }
  if (isAgentCardRail(requested) && capability.cardEligible !== true) {
    return refuse("capability_not_verified", `${requested} card eligibility is unconfirmed for this card`);
  }
  return { outcome: "authorized", rail: requested, capability };
}

// ── derived buyer identity ─────────────────────────────────────────────

export type AgentPaymentEnvironment = "sandbox" | "production";

/** The authenticated session half. These are the only identity inputs a
 * decision trusts; everything else in a request is a claim to be checked
 * against the server-owned mapping. */
export interface AgentPaymentSession {
  ownerId: string;
  deviceId: string;
}

/** Server-owned mapping from an authenticated account to a provider-side
 * subject. It is written by an owner's own setup, never by a model, a tool
 * argument or a request body. `buyerId` is absent until that setup happened,
 * and its absence is refused — there is deliberately no project-wide default
 * subject, because a shared subject is how one account's purchase becomes
 * another's. */
export interface AgentPaymentBuyerMapping {
  ownerId: string;
  deviceId: string;
  providerId: string;
  environment: AgentPaymentEnvironment;
  buyerId?: string;
}

export interface AgentPurchaseAuthority {
  session: AgentPaymentSession;
  buyerId: string;
  providerId: string;
  environment: AgentPaymentEnvironment;
}

/** Derive the provider identity that a purchase may act as, or refuse.
 * `claimedBuyerId`, when present, is a client/model-supplied id: it is never
 * trusted, and a mismatch is refused rather than ignored (silently
 * substituting the derived id would hide a confused or hostile caller). */
export function deriveAgentPaymentBuyer(
  session: AgentPaymentSession,
  mapping: AgentPaymentBuyerMapping,
  claimedBuyerId?: string,
): AgentPaymentDecision<{ authority: AgentPurchaseAuthority }> {
  if (mapping.ownerId !== session.ownerId) {
    return refuse("owner_mismatch", "the buyer mapping belongs to another account");
  }
  if (mapping.buyerId === undefined || mapping.buyerId === "") {
    return refuse("subject_missing", "no per-user provider subject is mapped; there is no project-wide fallback");
  }
  if (claimedBuyerId !== undefined && claimedBuyerId !== mapping.buyerId) {
    return refuse("buyer_not_derived", "the claimed buyer id is not the one derived from the authenticated mapping");
  }
  return {
    outcome: "authorized",
    authority: {
      session,
      buyerId: mapping.buyerId,
      providerId: mapping.providerId,
      environment: mapping.environment,
    },
  };
}

// ── sensitive material hygiene ─────────────────────────────────────────

/** Field names that must never carry real card data, a merchant password, a
 * wallet key or a one-time code into a model/message payload. Matching is on
 * the normalised name, so `cardNumber`, `card_number` and `CARD NUMBER` all
 * hit. */
const SENSITIVE_FIELD_PATTERN =
  /(pan|card_?number|cvv|cvc|security_?code|card_?expiry|expiry_?date|password|passcode|private_?key|seed_?phrase|mnemonic|keyphrase|signing_?key|signer_?key|api_?key|otp|one_?time_?code)/i;

/** An opaque provider-side payment method reference. A raw PAN is not opaque,
 * and neither is a Luhn-valid digit string in any spacing — that is the test
 * this pattern exists to survive. */
const OPAQUE_PAYMENT_METHOD_PATTERN = /^pm_[A-Za-z0-9_-]{4,64}$/;

const LuhnValid = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const character = digits[index];
    if (!/[0-9]/.test(character)) return false;
    let value = Number(character);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return digits.length >= 12 && sum % 10 === 0;
};

/** Does this string carry a card number in any of the shapes people paste? */
export function looksLikeCardNumber(value: string): boolean {
  const compact = value.replace(/[ -]/g, "");
  if (!/^\d{12,19}$/.test(compact)) return false;
  return LuhnValid(compact);
}

/** The payment method reference stored on an approval must stay a reference.
 * This is the check that keeps a PAN out of a durable approval record. */
export function isOpaquePaymentMethodRef(value: string): boolean {
  if (looksLikeCardNumber(value)) return false;
  return OPAQUE_PAYMENT_METHOD_PATTERN.test(value);
}

/** Refuse a model/message payload that carries payment secrets. Field labels
 * are what a model actually sees, so the label is the contract. */
export function assertNoSensitivePaymentMaterial(
  fields: readonly { label: string; text: string }[],
): AgentPaymentDecision<{ fields: number }> {
  for (const field of fields) {
    const label = field.label.replace(/[^A-Za-z0-9]/g, "_");
    if (SENSITIVE_FIELD_PATTERN.test(label) || SENSITIVE_FIELD_PATTERN.test(field.text)) {
      return refuse(
        "sensitive_material_in_payload",
        `"${field.label}" looks like card, credential or key material and may not enter a model/message payload`,
      );
    }
    if (looksLikeCardNumber(field.text)) {
      return refuse("sensitive_material_in_payload", `"${field.label}" contains a card number`);
    }
  }
  return { outcome: "authorized", fields: fields.length };
}

// ── purchase approvals ─────────────────────────────────────────────────

const ID_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const APPROVAL_ID_PATTERN = /^ap_[A-Za-z0-9_-]{3,61}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ORIGIN_PATTERN = /^https:\/\/[a-z0-9.-]+(?::\d{2,5})?$/;

/** One exact purchase the owner approved. This is the additive payment
 * authorisation record the plan describes; it hangs off the existing
 * task/intent rather than introducing a second agent runtime. */
export interface AgentPurchaseApproval {
  approvalId: string;
  /** Which revision of this approval's terms the owner actually saw. A
   * request carrying an older revision is a stale tap, not consent. */
  revision: number;
  ownerId: string;
  /** The task/intent this purchase belongs to. */
  taskId: string;
  /** The single device the approval was granted on. */
  deviceId: string;
  providerId: string;
  buyerId: string;
  environment: AgentPaymentEnvironment;
  /** Opaque provider-side reference. Never a PAN. */
  paymentMethodRef: string;
  rail: AgentPaymentRail;
  /** The exact origin (card rail / checkout) or wallet payee the approval is
   * bound to. */
  payee: string;
  /** The exact origin string, kept beside `payee` so a merchant change is
   * visible without parsing a payee. Empty for wallet payees. */
  origin: string;
  /** sha256 of the exact item/variant/quantity payload that was shown. */
  itemDigest: string;
  /** The quoted exact amount. */
  amount: AgentPaymentAmount;
  /** The most the owner will allow, including fees, tax and shipping that
   * cannot be known exactly. Always ≥ `amount`. */
  maxTotal: AgentPaymentAmount;
  recurring: boolean;
  issuedAt: number;
  expiresAt: number;
  /** Set once an approval's terms changed; the older revision stays readable
   * so a stale tap can be told apart from a forged id. */
  supersedesRevision?: number;
  /** The revision that replaced this one, if any. */
  supersededByRevision?: number;
  /** The reservation that consumed this exact revision, if any. */
  consumedByReservationId?: string;
  /** What the owner was told would be disclosed to the provider. A notice
   * without a persisted receipt is not approval. */
  disclosureReceiptId: string;
}

/** The terms a renewal may change. Everything here is either an exact amount,
 * an exact counterparty or an exact scope — a renewal cannot widen any of
 * them silently, because each change is a new revision a human approved. */
export interface AgentPurchaseApprovalChanges {
  amount?: AgentPaymentAmount;
  maxTotal?: AgentPaymentAmount;
  payee?: string;
  origin?: string;
  itemDigest?: string;
  paymentMethodRef?: string;
  rail?: AgentPaymentRail;
  expiresAt?: number;
  disclosureReceiptId?: string;
}

function requirePattern(value: string, pattern: RegExp, code: AgentPaymentDenialCode, field: string): string {
  if (!pattern.test(value)) {
    throw new AgentPaymentPolicyError(code, `${field} is not a valid ${pattern.source}`);
  }
  return value;
}

function requireSameCurrency(left: AgentPaymentAmount, right: AgentPaymentAmount, field: string): void {
  if (left.currency !== right.currency) {
    throw new AgentPaymentPolicyError("currency_changed", `${field} currency ${right.currency} does not match ${left.currency}`);
  }
}

/** Validate and freeze one approval's construction. Throwing is right here
 * because these are programmer/parse errors at a boundary, not policy
 * decisions about a live request. */
export function createAgentPurchaseApproval(
  approval: AgentPurchaseApproval,
): Readonly<AgentPurchaseApproval> {
  requirePattern(approval.approvalId, APPROVAL_ID_PATTERN, "approval_not_found", "approvalId");
  requirePattern(approval.ownerId, ID_PATTERN, "owner_mismatch", "ownerId");
  requirePattern(approval.taskId, ID_PATTERN, "task_mismatch", "taskId");
  requirePattern(approval.deviceId, ID_PATTERN, "device_mismatch", "deviceId");
  requirePattern(approval.buyerId, ID_PATTERN, "subject_missing", "buyerId");
  requirePattern(approval.providerId, ID_PATTERN, "subject_missing", "providerId");
  requirePattern(approval.disclosureReceiptId, ID_PATTERN, "subject_missing", "disclosureReceiptId");
  requirePattern(approval.itemDigest, DIGEST_PATTERN, "item_changed", "itemDigest");
  requirePattern(approval.payee, ID_PATTERN, "payee_changed", "payee");
  if (!Number.isSafeInteger(approval.revision) || approval.revision < 1) {
    throw new AgentPaymentPolicyError("approval_superseded", "revision must be a positive safe integer");
  }
  if (!isPermittedApprovalRail(approval.rail)) {
    throw new AgentPaymentPolicyError("rail_not_permitted", `rail ${approval.rail} cannot carry a purchase approval`);
  }
  if (!isOpaquePaymentMethodRef(approval.paymentMethodRef)) {
    throw new AgentPaymentPolicyError(
      "payment_method_not_opaque",
      "paymentMethodRef must be an opaque provider reference, never a card number",
    );
  }
  if (approval.origin !== "" && !ORIGIN_PATTERN.test(approval.origin)) {
    throw new AgentPaymentPolicyError("payee_changed", `origin ${approval.origin} is not an exact https origin`);
  }
  agentPaymentMinorUnitExponent(approval.amount.currency);
  requireSameCurrency(approval.amount, approval.maxTotal, "maxTotal");
  requireIntegerMinorUnits(approval.amount.minorUnits, "amount.minorUnits");
  requireIntegerMinorUnits(approval.maxTotal.minorUnits, "maxTotal.minorUnits");
  if (approval.maxTotal.minorUnits < approval.amount.minorUnits) {
    throw new AgentPaymentPolicyError("cap_exceeded", "maxTotal is below the quoted amount");
  }
  if (!Number.isSafeInteger(approval.expiresAt) || approval.expiresAt <= approval.issuedAt) {
    throw new AgentPaymentPolicyError("approval_expired", "expiresAt must be a later epoch millisecond than issuedAt");
  }
  return Object.freeze({ ...approval });
}

/** Approval storage, scoped per owner. `read` for an approval that belongs to
 * another owner is the same refusal as a forged id, so this cannot be used to
 * probe which ids exist. */
export class AgentPurchaseApprovalRegistry {
  readonly #records = new Map<string, AgentPurchaseApproval>();
  readonly #consumed = new Map<string, string>();

  #key(ownerId: string, approvalId: string): string {
    return `${ownerId}::${approvalId}`;
  }

  /** Store a new revision. Writing an older or equal revision over a newer
   * one is refused: that is a stale write racing a renewal. */
  put(approval: AgentPurchaseApproval): AgentPaymentDecision<{ approval: Readonly<AgentPurchaseApproval> }> {
    const frozen = createAgentPurchaseApproval(approval);
    const key = this.#key(frozen.ownerId, frozen.approvalId);
    const existing = this.#records.get(key);
    if (existing !== undefined && existing.revision >= frozen.revision) {
      return refuse(
        "approval_superseded",
        `revision ${frozen.revision} is not newer than the stored revision ${existing.revision}`,
      );
    }
    if (existing !== undefined) {
      this.#records.set(key, { ...existing, supersededByRevision: frozen.revision });
    }
    this.#records.set(key, { ...frozen });
    return { outcome: "authorized", approval: Object.freeze({ ...frozen }) };
  }

  /** The current record for this owner, or `null`. Another owner's record is
   * indistinguishable from a nonexistent one. */
  read(ownerId: string, approvalId: string): Readonly<AgentPurchaseApproval> | null {
    const record = this.#records.get(this.#key(ownerId, approvalId));
    if (record === undefined) return null;
    const reservationId = this.#consumed.get(this.#key(record.ownerId, record.approvalId));
    return Object.freeze({
      ...record,
      consumedByReservationId: reservationId,
    });
  }

  /** The record as seen at ONE revision. Asking for a revision that was
   * replaced returns the current terms flagged as superseded, so a stale
   * human tap is told it is stale instead of being compared anonymously.
   * A revision that never existed (higher than the current one) is `null`. */
  readAt(
    ownerId: string,
    approvalId: string,
    revision: number,
  ): Readonly<AgentPurchaseApproval> | null {
    const record = this.#records.get(this.#key(ownerId, approvalId));
    if (record === undefined) return null;
    if (revision > record.revision) return null;
    const consumedByReservationId = this.#consumed.get(
      `${this.#key(record.ownerId, record.approvalId)}#${revision}`,
    );
    return Object.freeze({
      ...record,
      revision,
      supersededByRevision: revision < record.revision ? record.revision : record.supersededByRevision,
      consumedByReservationId,
    });
  }

  /** Re-approve changed terms. The result is a NEW revision: a request that
   * still carries the old revision is refused, which is exactly what makes
   * "changed amount ⇒ renewed approval" a property rather than a promise. */
  renew(
    approval: Readonly<AgentPurchaseApproval>,
    changes: AgentPurchaseApprovalChanges,
    now: number,
  ): AgentPaymentDecision<{ approval: Readonly<AgentPurchaseApproval> }> {
    if (approval.consumedByReservationId !== undefined) {
      return refuse("approval_already_consumed", "a consumed approval is spent; start a new purchase approval");
    }
    const renewed: AgentPurchaseApproval = {
      ...approval,
      amount: changes.amount ?? approval.amount,
      maxTotal: changes.maxTotal ?? approval.maxTotal,
      payee: changes.payee ?? approval.payee,
      origin: changes.origin ?? approval.origin,
      itemDigest: changes.itemDigest ?? approval.itemDigest,
      paymentMethodRef: changes.paymentMethodRef ?? approval.paymentMethodRef,
      rail: changes.rail ?? approval.rail,
      expiresAt: changes.expiresAt ?? approval.expiresAt,
      disclosureReceiptId: changes.disclosureReceiptId ?? approval.disclosureReceiptId,
      revision: approval.revision + 1,
      issuedAt: now,
      supersedesRevision: approval.revision,
      supersededByRevision: undefined,
      consumedByReservationId: undefined,
    };
    return this.put(renewed);
  }

  /** Mark the exact owner+approval+revision as spent. The revision is part of
   * the key so a renewal is consumable in its own right. */
  markConsumed(ownerId: string, approvalId: string, revision: number, reservationId: string): void {
    this.#consumed.set(`${this.#key(ownerId, approvalId)}#${revision}`, reservationId);
  }

  /** The reservation that consumed a specific revision, if any. */
  consumptionOf(ownerId: string, approvalId: string, revision: number): string | null {
    return this.#consumed.get(`${this.#key(ownerId, approvalId)}#${revision}`) ?? null;
  }
}

// ── the purchase request a tool/model would like to make ───────────────

/** A purchase request as it arrives from a client, a model or a tool call.
 * Every field here is a CLAIM. Authority is checked against the registry,
 * the buyer mapping and the approval — never taken from this object. */
export interface AgentPurchaseRequest {
  approvalId: string;
  /** The revision the human actually saw. */
  approvalRevision: number;
  ownerId: string;
  taskId: string;
  deviceId: string;
  /** Optional client/model claim; checked against the derived mapping. */
  claimedBuyerId?: string;
  providerId: string;
  environment: AgentPaymentEnvironment;
  rail: AgentPaymentRail;
  paymentMethodRef: string;
  payee: string;
  origin: string;
  itemDigest: string;
  /** The amount about to be committed, in integer minor units. */
  amountMinorUnits: number;
  currency: string;
  /** One purchase is one purchase. Recurrence is a different envelope. */
  recurring: boolean;
  /** The single executor allowed to advance this intent. */
  executorId: string;
}

export interface AgentPurchaseAuthorization {
  approval: Readonly<AgentPurchaseApproval>;
  rail: AgentPaymentRail;
  /** The amount the approval binds, and the cap the ledger will hold. */
  amount: AgentPaymentAmount;
  cap: AgentPaymentAmount;
}

/** Decide whether a claimed purchase is provably inside an exact approval.
 * Every check below is a refusal someone asked for. The order is fixed so a
 * failure is reported as the most fundamental problem, not the first field
 * that happened to be wrong. */
export function authorizeAgentPaymentPurchase(
  registry: AgentPurchaseApprovalRegistry,
  session: AgentPaymentSession,
  mapping: AgentPaymentBuyerMapping,
  capabilities: readonly AgentRailCapability[],
  request: AgentPurchaseRequest,
  now: number,
): AgentPaymentDecision<AgentPurchaseAuthorization> {
  // Read AT the revision the caller claims to be acting on. A revision that
  // was replaced comes back flagged; a revision that never existed is
  // indistinguishable from a forged id.
  const approval = registry.readAt(request.ownerId, request.approvalId, request.approvalRevision);
  if (approval === null) {
    // A forged id, another owner's id and a deleted approval are one refusal.
    return refuse("approval_not_found", "no purchase approval is visible to this account");
  }
  // The lookup above is scoped by the owner the request CLAIMS, so this
  // comparison is what stops an authenticated session for one account from
  // spending another account's approval that it happened to name. The two
  // other reachable owner refusals are the lookup returning nothing at all
  // and the mapping check inside `deriveAgentPaymentBuyer` below.
  if (approval.ownerId !== session.ownerId || approval.ownerId !== request.ownerId) {
    return refuse("owner_mismatch", "this purchase approval belongs to another account");
  }
  if (request.taskId !== approval.taskId) {
    return refuse("task_mismatch", "this purchase approval belongs to another task");
  }
  if (request.deviceId !== approval.deviceId || session.deviceId !== approval.deviceId) {
    return refuse("device_mismatch", "this purchase approval belongs to another device");
  }
  const derived = deriveAgentPaymentBuyer(session, mapping, request.claimedBuyerId);
  if (derived.outcome === "refused") return derived;
  if (derived.authority.buyerId !== approval.buyerId) {
    return refuse("buyer_not_derived", "the approval's buyer is not the account's derived buyer");
  }
  if (
    request.providerId !== approval.providerId ||
    request.environment !== approval.environment ||
    derived.authority.providerId !== approval.providerId ||
    derived.authority.environment !== approval.environment
  ) {
    return refuse("project_environment_mismatch", "provider project/environment does not match the approval");
  }
  // `readAt` already resolved the revision: asking for one that was replaced
  // comes back flagged, and asking for one that never existed came back as
  // nothing. What is left is the human's terms being out of date.
  if (approval.supersededByRevision !== undefined) {
    return refuse(
      "approval_superseded",
      `approval revision ${approval.revision} was replaced by revision ${approval.supersededByRevision}; the renewed terms must be approved`,
    );
  }
  if (approval.consumedByReservationId !== undefined) {
    return refuse(
      "approval_already_consumed",
      `approval revision ${approval.revision} already funded purchase ${approval.consumedByReservationId}`,
    );
  }
  if (!Number.isSafeInteger(now) || now >= approval.expiresAt) {
    return refuse("approval_expired", "the purchase approval has expired");
  }
  if (!Number.isSafeInteger(request.amountMinorUnits) || request.amountMinorUnits < 0) {
    return refuse("amount_not_integer_minor_units", "the committed amount must be an integer count of minor units");
  }
  if (request.currency !== approval.amount.currency) {
    return refuse("currency_changed", `the approval is in ${approval.amount.currency}, not ${request.currency}`);
  }
  if (request.amountMinorUnits !== approval.amount.minorUnits) {
    return refuse("amount_changed", `the approval binds ${approval.amount.minorUnits} minor units, not ${request.amountMinorUnits}`);
  }
  if (request.amountMinorUnits > approval.maxTotal.minorUnits) {
    return refuse("cap_exceeded", "the committed amount exceeds the approved cap");
  }
  if (request.itemDigest !== approval.itemDigest) {
    return refuse("item_changed", "the item payload differs from the approved one");
  }
  if (request.payee !== approval.payee || request.origin !== approval.origin) {
    return refuse("payee_changed", "the merchant/payee differs from the approved one");
  }
  if (request.recurring && !approval.recurring) {
    return refuse("recurrence_added", "the approval is for a single purchase, not a recurring charge");
  }
  if (request.paymentMethodRef !== approval.paymentMethodRef) {
    return refuse("payment_method_changed", "the payment method differs from the approved one");
  }
  const rail = selectAgentPaymentRail(request.rail, capabilities);
  if (rail.outcome === "refused") return rail;
  if (rail.rail !== approval.rail) {
    return refuse("rail_not_permitted", `the approval binds rail ${approval.rail}, not ${request.rail}`);
  }
  return {
    outcome: "authorized",
    approval,
    rail: rail.rail,
    amount: { currency: approval.amount.currency, minorUnits: approval.amount.minorUnits },
    cap: { currency: approval.maxTotal.currency, minorUnits: approval.maxTotal.minorUnits },
  };
}

// ── budget ledger: reserve the cap, settle from authority ──────────────

export type AgentPurchaseReservationState = "held" | "retained_unknown" | "settled" | "voided";

/** The distinct, non-interchangeable payment outcomes. "The provider said it
 * worked", "we hold a receipt", "the receipt was independently verified" and
 * "nobody knows" are four different facts, and collapsing them is how a user
 * is told a purchase succeeded when it may not have. */
export type AgentPaymentOutcomeState =
  | "none"
  | "unknown"
  | "cancellation_requested"
  | "success_reported"
  | "receipt_captured"
  | "receipt_verified";

/** One-way ladder. A lower rank arriving after a higher one is a duplicate or
 * out-of-order event and is refused rather than allowed to un-know a receipt. */
const OUTCOME_RANK: ReadonlyMap<AgentPaymentOutcomeState, number> = new Map<AgentPaymentOutcomeState, number>([
  ["none", 0],
  ["unknown", 0],
  ["cancellation_requested", 0],
  ["success_reported", 1],
  ["receipt_captured", 2],
  ["receipt_verified", 3],
]);

export interface AgentPurchaseReservation {
  reservationId: string;
  ownerId: string;
  approvalId: string;
  approvalRevision: number;
  currency: string;
  /** The approved CAP is what is held, not the quote: fees, tax and shipping
   * that could not be known exactly are inside the cap the owner approved. */
  reservedMinorUnits: number;
  state: AgentPurchaseReservationState;
  outcomeState: AgentPaymentOutcomeState;
  /** Set as soon as any effect was started. A create-run that timed out before
   * a run id arrived still started an effect, so this is true with no run id. */
  submissionStarted: boolean;
  providerRunId: string | null;
  /** The single executor that may advance this intent. A lease is not
   * exactly-once: a stale holder still needs provider reconciliation. */
  executorId: string;
  leaseExpiresAt: number;
  settledMinorUnits: number | null;
  heldAt: number;
  lastEventAt: number;
  /** A cancellation was requested and nothing authoritative followed. */
  cancellationRequestedAt?: number;
  /** A refund that the provider actually confirmed — a different fact from a
   * cancellation request, and not implied by one. */
  refundState?: "not_requested" | "refund_recorded" | "refund_failed";
}

/** One mint, kept apart from merchant charges and from purchase
 * reservations: the plan requires credential-mint allowance to be tracked on
 * its own, because minting spends rail allowance whether or not anything is
 * bought with it. */
export interface AgentCredentialMint {
  ownerId: string;
  credentialRef: string;
  railAllowanceMinorUnits: number;
  purchaseReservationId?: string;
  settledByPurchase: boolean;
  at: number;
}

export interface AgentPurchaseBudget {
  ownerId: string;
  currency: string;
  limitMinorUnits: number;
  reservedMinorUnits: number;
  settledMinorUnits: number;
}

export interface AgentReservationRequest {
  ownerId: string;
  approvalId: string;
  approvalRevision: number;
  currency: string;
  /** The cap to hold. */
  amountMinorUnits: number;
  executorId: string;
  now: number;
  leaseMs?: number;
}

export interface AgentPaymentOutcome {
  state: AgentPaymentOutcomeState;
  providerRunId?: string;
  /** Required to settle: the authoritative amount actually charged. */
  chargedMinorUnits?: number;
  /** Receipt reference; present from `receipt_captured` on. */
  receiptRef?: string;
  reason?: string;
}

const DEFAULT_LEASE_MS = 30_000;

/**
 * The local purchase budget. Separate from subscription billing and from
 * model usage by construction: it is keyed by account+currency, it only ever
 * moves because this module's own reserve/settle ran, and nothing outside
 * this file writes it.
 */
export class AgentPurchaseBudgetLedger {
  readonly #budgets = new Map<string, AgentPurchaseBudget>();
  readonly #reservations = new Map<string, AgentPurchaseReservation>();
  readonly #sequences = new Map<string, number>();
  readonly #mints = new Map<string, AgentCredentialMint>();

  #budgetKey(ownerId: string, currency: string): string {
    return `${ownerId}::${currency}`;
  }

  /** Configure a local mock cap. Refuses to shrink a limit below what is
   * already committed, because a limit that silently drops under a live
   * reservation is a budget that lies. */
  setLimit(ownerId: string, currency: string, limitMinorUnits: number): AgentPaymentDecision<{ budget: Readonly<AgentPurchaseBudget> }> {
    agentPaymentMinorUnitExponent(currency);
    requireIntegerMinorUnits(limitMinorUnits, "limitMinorUnits");
    const key = this.#budgetKey(ownerId, currency);
    const existing = this.#budgets.get(key);
    const committed = (existing?.reservedMinorUnits ?? 0) + (existing?.settledMinorUnits ?? 0);
    if (limitMinorUnits < committed) {
      return refuse("budget_limit_below_committed", `limit ${limitMinorUnits} is below the ${committed} already committed`);
    }
    const budget: AgentPurchaseBudget = {
      ownerId,
      currency,
      limitMinorUnits,
      reservedMinorUnits: existing?.reservedMinorUnits ?? 0,
      settledMinorUnits: existing?.settledMinorUnits ?? 0,
    };
    this.#budgets.set(key, budget);
    return { outcome: "authorized", budget: Object.freeze({ ...budget }) };
  }

  readBudget(ownerId: string, currency: string): Readonly<AgentPurchaseBudget> | null {
    const budget = this.#budgets.get(this.#budgetKey(ownerId, currency));
    return budget === undefined ? null : Object.freeze({ ...budget });
  }

  /** Budget still free for this account and currency. Reserved money for an
   * unknown outcome is NOT free. */
  availableMinorUnits(ownerId: string, currency: string): number {
    const budget = this.#budgets.get(this.#budgetKey(ownerId, currency));
    if (budget === undefined) return 0;
    return budget.limitMinorUnits - budget.reservedMinorUnits - budget.settledMinorUnits;
  }

  readReservation(reservationId: string): Readonly<AgentPurchaseReservation> | null {
    const reservation = this.#reservations.get(reservationId);
    return reservation === undefined ? null : Object.freeze({ ...reservation });
  }

  /** Reservations that are holding budget because nobody knows the outcome.
   * These are the rows a reconciliation view must show. */
  unresolved(ownerId: string): readonly Readonly<AgentPurchaseReservation>[] {
    const rows: Readonly<AgentPurchaseReservation>[] = [];
    for (const reservation of this.#reservations.values()) {
      if (reservation.ownerId === ownerId && reservation.state === "retained_unknown") {
        rows.push(Object.freeze({ ...reservation }));
      }
    }
    return rows;
  }

  /**
   * Hold the approved cap for one purchase. Effects may only start after this
   * returns authorized.
   *
   * Async purely so the C1 store seam can await a durable write. The check
   * and the commit are ONE synchronous step and nothing may be awaited
   * between them: a yield between "is there budget" and "take the budget" is
   * precisely how two concurrent purchases overspend the same cap.
   */
  async reserve(
    request: AgentReservationRequest,
  ): Promise<AgentPaymentDecision<{ reservation: Readonly<AgentPurchaseReservation> }>> {
    const currency = request.currency;
    agentPaymentMinorUnitExponent(currency);
    requireIntegerMinorUnits(request.amountMinorUnits, "amountMinorUnits");
    const budget = this.#budgets.get(this.#budgetKey(request.ownerId, currency));
    if (budget === undefined) {
      return refuse("budget_not_configured", `no purchase budget is configured for ${currency}`);
    }
    // ---- check ----
    const available = budget.limitMinorUnits - budget.reservedMinorUnits - budget.settledMinorUnits;
    if (request.amountMinorUnits > available) {
      return refuse(
        "budget_exhausted",
        `${request.amountMinorUnits} exceeds the ${available} still available in ${currency}`,
      );
    }
    // ---- commit (no await between the check above and this mutation) ----
    budget.reservedMinorUnits += request.amountMinorUnits;
    const sequence = (this.#sequences.get(request.ownerId) ?? 0) + 1;
    this.#sequences.set(request.ownerId, sequence);
    const reservation: AgentPurchaseReservation = {
      reservationId: `rsv_${request.ownerId}_${sequence}`,
      ownerId: request.ownerId,
      approvalId: request.approvalId,
      approvalRevision: request.approvalRevision,
      currency,
      reservedMinorUnits: request.amountMinorUnits,
      state: "held",
      outcomeState: "none",
      submissionStarted: false,
      providerRunId: null,
      executorId: request.executorId,
      leaseExpiresAt: request.now + (request.leaseMs ?? DEFAULT_LEASE_MS),
      settledMinorUnits: null,
      heldAt: request.now,
      lastEventAt: request.now,
      refundState: "not_requested",
    };
    this.#reservations.set(reservation.reservationId, reservation);
    return { outcome: "authorized", reservation: Object.freeze({ ...reservation }) };
  }

  #leaseCheck(
    reservationId: string,
    executorId: string,
    now: number,
  ): AgentPaymentDecision<{ reservation: AgentPurchaseReservation }> {
    const reservation = this.#reservations.get(reservationId);
    if (reservation === undefined) {
      return refuse("reservation_not_found", `no reservation ${reservationId}`);
    }
    if (reservation.state === "voided") {
      return refuse("reservation_voided", "this reservation was voided before any effect started");
    }
    if (reservation.executorId !== executorId) {
      return refuse("lease_not_held", "another executor holds this payment intent");
    }
    if (now > reservation.leaseExpiresAt) {
      return refuse("lease_not_held", "the executor lease expired; reconcile with the provider before advancing");
    }
    return { outcome: "authorized", reservation };
  }

  /** As `leaseCheck`, plus: only a reservation that has not settled may be
   * submitted or voided. */
  #requireHeld(
    reservationId: string,
    executorId: string,
    now: number,
  ): AgentPaymentDecision<{ reservation: AgentPurchaseReservation }> {
    const checked = this.#leaseCheck(reservationId, executorId, now);
    if (checked.outcome === "refused") return checked;
    if (checked.reservation.state === "settled") {
      return refuse("reservation_already_settled", "this reservation is already settled");
    }
    return checked;
  }

  /**
   * Record that a provider effect was started. `providerRunId` is null when a
   * create-run timed out before an id came back: the local intent stays
   * UNKNOWN and its reservation stays held, because a timeout is not proof
   * that nothing was created. Re-issuing the create is not this module's
   * move — that is a reconciliation decision by the owner.
   */
  markSubmitted(
    reservationId: string,
    submission: { providerRunId: string | null },
    executorId: string,
    now: number,
  ): AgentPaymentDecision<{ reservation: Readonly<AgentPurchaseReservation> }> {
    const held = this.#requireHeld(reservationId, executorId, now);
    if (held.outcome === "refused") return held;
    const reservation = held.reservation;
    reservation.submissionStarted = true;
    reservation.providerRunId = submission.providerRunId;
    reservation.state = "retained_unknown";
    reservation.outcomeState = "unknown";
    reservation.lastEventAt = now;
    return { outcome: "authorized", reservation: Object.freeze({ ...reservation }) };
  }

  /**
   * Advance the outcome ladder. Only an authoritative receipt settles the
   * budget; everything else RETAINS the reservation. A cancellation request is
   * recorded as exactly that, and moves no money. A later, stronger
   * attestation may upgrade a settled row's receipt state, but a settlement is
   * never a second charge.
   */
  applyOutcome(
    reservationId: string,
    outcome: AgentPaymentOutcome,
    executorId: string,
    now: number,
  ): AgentPaymentDecision<{ reservation: Readonly<AgentPurchaseReservation> }> {
    if (outcome.state === "none") {
      return refuse("outcome_downgrade", "an unknown/none outcome is not an event");
    }
    const checked = this.#leaseCheck(reservationId, executorId, now);
    if (checked.outcome === "refused") return checked;
    const reservation = checked.reservation;
    const nextRank = OUTCOME_RANK.get(outcome.state) ?? 0;
    const currentRank = OUTCOME_RANK.get(reservation.outcomeState) ?? 0;
    if (nextRank < currentRank) {
      return refuse(
        "outcome_downgrade",
        `${outcome.state} cannot replace the already-recorded ${reservation.outcomeState}`,
      );
    }
    if (outcome.providerRunId !== undefined && reservation.providerRunId !== null && outcome.providerRunId !== reservation.providerRunId) {
      return refuse("outcome_downgrade", "the outcome names a different provider run than this reservation");
    }
    if (outcome.providerRunId !== undefined) reservation.providerRunId = outcome.providerRunId;
    if (reservation.state === "settled") {
      // The money already moved. A later receipt may only ATTEST more
      // strongly to the same amount; it can never charge again.
      if (outcome.state !== "receipt_verified") {
        return refuse("reservation_already_settled", "this reservation is already settled");
      }
      if (outcome.chargedMinorUnits !== undefined && outcome.chargedMinorUnits !== reservation.settledMinorUnits) {
        return refuse("outcome_downgrade", "a settled charge cannot be restated at a different amount");
      }
      reservation.outcomeState = "receipt_verified";
      reservation.lastEventAt = now;
      return { outcome: "authorized", reservation: Object.freeze({ ...reservation }) };
    }
    reservation.outcomeState = outcome.state;
    reservation.lastEventAt = now;
    if (outcome.state === "cancellation_requested") {
      reservation.cancellationRequestedAt = now;
      reservation.state = "retained_unknown";
      return { outcome: "authorized", reservation: Object.freeze({ ...reservation }) };
    }
    if (outcome.state !== "receipt_captured" && outcome.state !== "receipt_verified") {
      // reported, or unknown: the money position is still unresolved.
      reservation.state = "retained_unknown";
      return { outcome: "authorized", reservation: Object.freeze({ ...reservation }) };
    }
    if (outcome.chargedMinorUnits === undefined || !Number.isSafeInteger(outcome.chargedMinorUnits) || outcome.chargedMinorUnits < 0) {
      return refuse("charge_amount_missing", "a captured receipt needs the exact charged amount in minor units");
    }
    const charged = outcome.chargedMinorUnits;
    if (charged > reservation.reservedMinorUnits) {
      // The cap was exceeded somewhere outside this module. Retain, and say
      // so; never quietly settle a number the owner did not approve.
      reservation.state = "retained_unknown";
      return refuse(
        "settled_amount_exceeds_reservation",
        `charged ${charged} exceeds the reserved cap ${reservation.reservedMinorUnits}`,
      );
    }
    const budget = this.#budgets.get(this.#budgetKey(reservation.ownerId, reservation.currency));
    if (budget === undefined) {
      reservation.state = "retained_unknown";
      return refuse("budget_not_configured", "the budget backing this reservation is gone");
    }
    budget.reservedMinorUnits -= reservation.reservedMinorUnits;
    budget.settledMinorUnits += charged;
    reservation.settledMinorUnits = charged;
    reservation.reservedMinorUnits = 0;
    reservation.state = "settled";
    return { outcome: "authorized", reservation: Object.freeze({ ...reservation }) };
  }

  /**
   * Release a reservation that provably never started an effect. This is the
   * ONLY path that gives reserved money back, and it refuses the moment
   * `submissionStarted` is true — including the create-run-timeout case,
   * where a provider run may exist and nobody has seen its id yet.
   */
  voidReservation(
    reservationId: string,
    executorId: string,
    now: number,
  ): AgentPaymentDecision<{ reservation: Readonly<AgentPurchaseReservation> }> {
    const held = this.#requireHeld(reservationId, executorId, now);
    if (held.outcome === "refused") return held;
    const reservation = held.reservation;
    if (reservation.submissionStarted) {
      return refuse(
        "outcome_unknown",
        "an effect was started; the reservation is retained until the outcome is authoritative",
      );
    }
    const budget = this.#budgets.get(this.#budgetKey(reservation.ownerId, reservation.currency));
    if (budget === undefined) {
      return refuse("budget_not_configured", "the budget backing this reservation is gone");
    }
    budget.reservedMinorUnits -= reservation.reservedMinorUnits;
    reservation.reservedMinorUnits = 0;
    reservation.state = "voided";
    reservation.lastEventAt = now;
    return { outcome: "authorized", reservation: Object.freeze({ ...reservation }) };
  }

  /**
   * Record a refund outcome on an already-settled reservation. A refund is a
   * separate, separately-evidenced fact: it does not follow from a
   * cancellation request, and it does not silently give the purchase budget
   * back (restoring a cap is the owner's decision, not a side effect).
   */
  recordRefund(
    reservationId: string,
    refund: { state: "refund_recorded" | "refund_failed"; reference?: string },
    now: number,
  ): AgentPaymentDecision<{ reservation: Readonly<AgentPurchaseReservation>; budgetRestored: false }> {
    const reservation = this.#reservations.get(reservationId);
    if (reservation === undefined) {
      return refuse("reservation_not_found", `no reservation ${reservationId}`);
    }
    if (reservation.state !== "settled") {
      return refuse("refund_requires_settlement", "only a settled reservation can carry a refund outcome");
    }
    reservation.refundState = refund.state;
    reservation.lastEventAt = now;
    return { outcome: "authorized", reservation: Object.freeze({ ...reservation }), budgetRestored: false };
  }

  /**
   * Record a credential mint. Minting consumes rail allowance even when the
   * credential is never used, and a mint that bought nothing is neither a
   * purchase nor reusable budget — it is an allowance fact that has to be
   * reconciled with the provider, so it is stored in its own ledger and never
   * turns back into purchase budget on its own.
   */
  recordCredentialMint(
    mint: { ownerId: string; credentialRef: string; railAllowanceMinorUnits: number; purchaseReservationId?: string },
    now: number,
  ): AgentPaymentDecision<{ credentialRef: string; reconciled: boolean }> {
    requireIntegerMinorUnits(mint.railAllowanceMinorUnits, "railAllowanceMinorUnits");
    if (mint.purchaseReservationId !== undefined) {
      const reservation = this.#reservations.get(mint.purchaseReservationId);
      if (reservation === undefined) {
        return refuse("reservation_not_found", `no reservation ${mint.purchaseReservationId}`);
      }
      if (reservation.state !== "settled") {
        return refuse("credential_still_reconciling", "a mint cannot ride on an unsettled reservation");
      }
      this.#mints.set(mint.credentialRef, { ...mint, settledByPurchase: true, at: now });
      return { outcome: "authorized", credentialRef: mint.credentialRef, reconciled: true };
    }
    this.#mints.set(mint.credentialRef, { ...mint, settledByPurchase: false, at: now });
    return { outcome: "authorized", credentialRef: mint.credentialRef, reconciled: false };
  }

  /** Mints that consumed rail allowance without a purchase behind them. */
  unreconciledMints(ownerId: string): readonly Readonly<AgentCredentialMint>[] {
    const rows: Readonly<AgentCredentialMint>[] = [];
    for (const mint of this.#mints.values()) {
      if (mint.ownerId === ownerId && !mint.settledByPurchase) rows.push(Object.freeze({ ...mint }));
    }
    return rows;
  }
}

// ── the one entry point: authorize, then reserve, then nothing else ────

export interface AgentPurchasePreparation {
  approval: Readonly<AgentPurchaseApproval>;
  reservation: Readonly<AgentPurchaseReservation>;
  rail: AgentPaymentRail;
  cap: AgentPaymentAmount;
}

/**
 * Authorize a claimed purchase and hold its cap in one step. Order matters
 * and is the reason this is one function: the reservation is taken only after
 * the approval is proven, and the approval is marked consumed only after the
 * reservation is actually held. A caller may start an effect if and only if
 * it receives `authorized` from here.
 */
export async function prepareAgentPurchase(
  registry: AgentPurchaseApprovalRegistry,
  ledger: AgentPurchaseBudgetLedger,
  session: AgentPaymentSession,
  mapping: AgentPaymentBuyerMapping,
  capabilities: readonly AgentRailCapability[],
  request: AgentPurchaseRequest,
  now: number,
): Promise<AgentPaymentDecision<AgentPurchasePreparation>> {
  const authorized = authorizeAgentPaymentPurchase(registry, session, mapping, capabilities, request, now);
  if (authorized.outcome === "refused") return authorized;
  const reserved = await ledger.reserve({
    ownerId: authorized.approval.ownerId,
    approvalId: authorized.approval.approvalId,
    approvalRevision: authorized.approval.revision,
    currency: authorized.cap.currency,
    amountMinorUnits: authorized.cap.minorUnits,
    executorId: request.executorId,
    now,
  });
  if (reserved.outcome === "refused") return reserved;
  registry.markConsumed(
    authorized.approval.ownerId,
    authorized.approval.approvalId,
    authorized.approval.revision,
    reserved.reservation.reservationId,
  );
  return {
    outcome: "authorized",
    approval: authorized.approval,
    reservation: reserved.reservation,
    rail: authorized.rail,
    cap: authorized.cap,
  };
}

// ── wallet scopes: explicit, bounded, no wildcards ─────────────────────

/** Only `transfer` has a reviewed-enforcement story in C0. A swap, bridge,
 * contract call, typed-data signature or arbitrary message is refused even if
 * a scope names the same token, because a transfer cap is not evidence about
 * those paths. */
export type AgentWalletOperation = "transfer" | "swap" | "bridge" | "contract_call" | "typed_data" | "sign_message";

export const AGENT_WALLET_PROVEN_OPERATIONS: ReadonlySet<AgentWalletOperation> = new Set<AgentWalletOperation>([
  "transfer",
]);

/** An explicit wallet scope. There is no wildcard member in this type, so a
 * scope with `recipients: ["*"]` is a parse/validation failure, not a
 * default. There is also no exported default scope object. */
export interface AgentWalletScope {
  scopeId: string;
  ownerId: string;
  chain: AgentTokenChain;
  asset: AgentTokenAsset;
  /** Cap in the token's own minor units. Required, integer, positive. */
  maxAmountMinorUnits: number;
  /** Nonempty allowlist. No `*`, no empty string, no duplicates-with-case
   * folding that hides a different address. */
  recipients: readonly string[];
  expiresAt: number;
  capability: "transfer_only";
}

const ADDRESS_PATTERN = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

const walletScopeSchema = z.object({
  scopeId: z.string().min(4).max(64),
  ownerId: z.string().min(3).max(64),
  chain: z.enum(AGENT_TOKEN_CHAINS),
  contract: z.string().min(1).max(64),
  decimals: z.number().int().min(0).max(30),
  symbol: z.string().min(1).max(16),
  maxAmountMinorUnits: z.number().int().positive(),
  recipients: z.array(z.string().min(1).max(64)),
  expiresAt: z.number().int().positive(),
});

/** Which refusal a malformed scope field earns. A missing allowlist and a
 * missing cap are different defects and get different codes — a caller must
 * be able to tell "you named no recipient" from "you named no cap". */
const SCOPE_ISSUE_CODES: ReadonlyMap<string, AgentPaymentDenialCode> = new Map<string, AgentPaymentDenialCode>([
  ["recipients", "scope_recipients_empty"],
  ["maxAmountMinorUnits", "scope_amount_missing"],
  ["chain", "unknown_chain"],
  ["contract", "unknown_asset"],
  ["decimals", "amount_decimals_unproven"],
  ["symbol", "unknown_asset"],
  ["expiresAt", "scope_expired"],
  ["ownerId", "owner_mismatch"],
  ["scopeId", "scope_incomplete"],
]);

/** Decode an untrusted scope at its boundary. Omitted/empty recipients and
 * missing caps are refusals here, before any wallet logic sees them. */
export function parseAgentWalletScope(
  input: {
    scopeId?: unknown;
    ownerId?: unknown;
    chain?: unknown;
    contract?: unknown;
    decimals?: unknown;
    symbol?: unknown;
    maxAmountMinorUnits?: unknown;
    recipients?: unknown;
    expiresAt?: unknown;
  },
  now: number,
): AgentPaymentDecision<{ scope: AgentWalletScope }> {
  const parsed = walletScopeSchema.safeParse(input);
  if (!parsed.success) {
    const code = SCOPE_ISSUE_CODES.get(String(parsed.error.issues[0]?.path[0] ?? "")) ?? "scope_incomplete";
    return refuse(code, `malformed wallet scope: ${parsed.error.issues[0]?.message ?? "unreadable"}`);
  }
  const data = parsed.data;
  if (data.recipients.length === 0) {
    return refuse("scope_recipients_empty", "an empty recipient allowlist authorises nothing and is refused, not defaulted");
  }
  if (data.recipients.some((recipient) => recipient === "*" || !ADDRESS_PATTERN.test(recipient))) {
    return refuse("scope_wildcard_forbidden", "wildcard and malformed recipients are refused; name each recipient");
  }
  if (new Set(data.recipients.map((recipient) => recipient.toLowerCase())).size !== data.recipients.length) {
    return refuse("scope_wildcard_forbidden", "duplicate recipients in the allowlist");
  }
  if (data.expiresAt <= now) {
    return refuse("scope_expired", "this wallet scope has expired");
  }
  let asset: AgentTokenAsset;
  try {
    asset = assertRegisteredTokenAsset({ chain: data.chain, contract: data.contract, decimals: data.decimals, symbol: data.symbol });
  } catch (error) {
    if (error instanceof AgentPaymentPolicyError) {
      return refuse(error.code, error.message);
    }
    throw error;
  }
  return {
    outcome: "authorized",
    scope: {
      scopeId: data.scopeId,
      ownerId: data.ownerId,
      chain: data.chain,
      asset,
      maxAmountMinorUnits: data.maxAmountMinorUnits,
      recipients: [...data.recipients],
      expiresAt: data.expiresAt,
      capability: "transfer_only",
    },
  };
}

export interface AgentWalletTransferRequest {
  ownerId: string;
  operation: AgentWalletOperation;
  chain: string;
  contract: string;
  recipient: string;
  amountMinorUnits: number;
  now: number;
}

/** Authorize one wallet operation against an explicit scope, or refuse.
 * Fail-closed on every axis: wrong owner, unproven operation, unrecognised
 * chain/token, expired scope, recipient outside the allowlist, or a cap the
 * request exceeds. */
export function authorizeAgentWalletOperation(
  scope: AgentWalletScope,
  request: AgentWalletTransferRequest,
): AgentPaymentDecision<{ scope: AgentWalletScope; amountMinorUnits: number }> {
  if (scope.ownerId !== request.ownerId) {
    return refuse("owner_mismatch", "this wallet scope belongs to another account");
  }
  if (!AGENT_WALLET_PROVEN_OPERATIONS.has(request.operation)) {
    return refuse(
      "scope_operation_not_proven",
      `only a plain transfer has proven enforcement; ${request.operation} is refused`,
    );
  }
  if (scope.expiresAt <= request.now) {
    return refuse("scope_expired", "this wallet scope has expired");
  }
  if (request.chain !== scope.chain || request.contract.toLowerCase() !== scope.asset.contract.toLowerCase()) {
    return refuse("asset_changed", "the requested chain/token differs from the scope; a chain or token switch needs a new scope");
  }
  if (!Number.isSafeInteger(request.amountMinorUnits) || request.amountMinorUnits <= 0) {
    return refuse("scope_amount_missing", "a transfer needs a positive integer count of the token's minor units");
  }
  if (request.amountMinorUnits > scope.maxAmountMinorUnits) {
    return refuse("cap_exceeded", "the transfer exceeds the scoped cap");
  }
  if (!scope.recipients.some((recipient) => recipient.toLowerCase() === request.recipient.toLowerCase())) {
    return refuse("scope_recipient_not_allowed", "the recipient is not in the scope's allowlist");
  }
  return { outcome: "authorized", scope, amountMinorUnits: request.amountMinorUnits };
}

// ── paid calls: no global auto-paying fetch ────────────────────────────

/** Per-endpoint, per-payee consent for a wallet-backed HTTP payment. It is
 * deliberately narrow: exact origin, exact payee, exact asset, exact cap and
 * an expiry. There is no wildcard origin and no standing consent. */
export interface AgentPaidCallConsent {
  consentId: string;
  ownerId: string;
  /** Exact `https://host[:port]`. No path, no wildcard. */
  origin: string;
  payee: string;
  asset: AgentTokenAsset;
  maxAmountMinorUnits: number;
  expiresAt: number;
}

export interface AgentPaidCallRequest {
  ownerId: string;
  url: string;
  payee: string;
  chain: string;
  contract: string;
  amountMinorUnits: number;
  scheme: "x402" | "mpp" | "none";
  /** The transport's redirect behaviour. Only `manual` is acceptable: an
   * automatic redirect could send a payment to a different host. */
  redirect: "manual" | "follow" | "error";
  now: number;
}

export interface AgentPaidCallAuthorization {
  consent: AgentPaidCallConsent;
  /** The only affirmative outcome. There is deliberately no member meaning
   * "sign and retry automatically", and this module signs nothing. */
  requiresUserConfirmation: true;
}

/** Decide whether a paid HTTP call may be offered to a human. It can only
 * return "refused" or "requires_user_confirmation" — the affirmative branch
 * hands the decision back to the user instead of paying. */
export function authorizeAgentPaidCall(
  consent: AgentPaidCallConsent,
  request: AgentPaidCallRequest,
): AgentPaymentDecision<AgentPaidCallAuthorization> {
  if (consent.ownerId !== request.ownerId) {
    return refuse("owner_mismatch", "this paid-call consent belongs to another account");
  }
  if (request.scheme === "none") {
    return refuse("auto_pay_not_permitted", "an ordinary URL fetch carries no payment envelope");
  }
  if (request.redirect !== "manual") {
    return refuse("auto_pay_redirect_forbidden", "only manual redirects are acceptable near a payment");
  }
  if (consent.expiresAt <= request.now) {
    return refuse("auto_pay_consent_expired", "this paid-call consent has expired");
  }
  let requestOrigin: string;
  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    return refuse("auto_pay_endpoint_not_pinned", "the request URL is not an absolute http(s) URL");
  }
  if (requestOrigin !== consent.origin || requestOrigin !== new URL(consent.origin).origin) {
    return refuse("auto_pay_endpoint_not_pinned", "the request endpoint is not the consented origin");
  }
  if (request.payee !== consent.payee) {
    return refuse("payee_changed", "the payment challenge names a different payee than the consent");
  }
  if (request.chain !== consent.asset.chain || request.contract.toLowerCase() !== consent.asset.contract.toLowerCase()) {
    return refuse("auto_pay_network_mismatch", "the challenge names a different chain/token than the consent");
  }
  if (!Number.isSafeInteger(request.amountMinorUnits) || request.amountMinorUnits <= 0) {
    return refuse("scope_amount_missing", "a paid call needs a positive integer amount in the token's minor units");
  }
  if (request.amountMinorUnits > consent.maxAmountMinorUnits) {
    return refuse("cap_exceeded", "the challenge price exceeds the consented cap");
  }
  return { outcome: "authorized", consent, requiresUserConfirmation: true };
}

// ── authority lifecycle: revoke, disconnect, restore ───────────────────

/** The local record of what this account has connected. It holds opaque
 * references only — no card data, no key material, nothing a chat export
 * should ever carry. */
export interface AgentPaymentAuthority {
  ownerId: string;
  /** The device these connections were authorised on. A different device
   * needs a fresh approval; it does not inherit them. */
  boundDeviceId: string;
  paymentMethods: string[];
  mintedCredentials: string[];
  signers: string[];
  /** New dispatch is refused once disconnect has run. */
  dispatchBlocked: boolean;
}

export type AgentRevocationKind = "payment_method" | "minted_credential" | "wallet_signer";

export interface AgentRevocationReceipt {
  kind: AgentRevocationKind;
  reference: string;
  at: number;
  /** Provider confirmations we have NOT received. A revocation that was
   * requested is not a revocation that happened. */
  unconfirmed: string[];
  /** Approvals that are still live after this operation. Deleting a payment
   * method does not cancel them; they must be revoked explicitly. */
  outstandingApprovals: string[];
  /** Credential mints that consumed rail allowance with no purchase. */
  unreconciledMints: string[];
  dispatchBlocked: boolean;
}

/** The three revocations are three separate operations with three separate
 * effects. This function performs exactly one of them, chosen by `kind`. */
export function revokeAgentPaymentAuthority(
  authority: AgentPaymentAuthority,
  request: { kind: AgentRevocationKind; reference: string },
  outstandingApprovals: readonly { approvalId: string; revision: number; paymentMethodRef: string; credentialRef?: string; signerRef?: string }[],
  unconfirmedMints: readonly string[],
  now: number,
): AgentPaymentDecision<{ receipt: AgentRevocationReceipt }> {
  if (request.kind === "payment_method") {
    if (!authority.paymentMethods.includes(request.reference)) {
      return refuse("payment_method_not_found", "no such payment method is connected");
    }
    authority.paymentMethods = authority.paymentMethods.filter((entry) => entry !== request.reference);
  } else if (request.kind === "minted_credential") {
    if (!authority.mintedCredentials.includes(request.reference)) {
      return refuse("credential_not_found", "no such minted credential is connected");
    }
    authority.mintedCredentials = authority.mintedCredentials.filter((entry) => entry !== request.reference);
  } else {
    if (!authority.signers.includes(request.reference)) {
      return refuse("signer_not_found", "no such wallet signer is connected");
    }
    authority.signers = authority.signers.filter((entry) => entry !== request.reference);
  }
  const relevant = outstandingApprovals.filter((approval) =>
    request.kind === "payment_method"
      ? approval.paymentMethodRef === request.reference
      : request.kind === "minted_credential"
        ? approval.credentialRef === request.reference
        : approval.signerRef === request.reference,
  );
  return {
    outcome: "authorized",
    receipt: {
      kind: request.kind,
      reference: request.reference,
      at: now,
      unconfirmed: [],
      outstandingApprovals: relevant.map((approval) => `${approval.approvalId}#${approval.revision}`),
      unreconciledMints: request.kind === "minted_credential" ? [...unconfirmedMints] : [],
      dispatchBlocked: authority.dispatchBlocked,
    },
  };
}

/** A revocation that was REQUESTED is not a revocation that happened. This
 * is the check a UI runs before it tells an owner payments are disconnected. */
export function assertAgentRevocationsConfirmed(
  receipt: AgentRevocationReceipt,
): AgentPaymentDecision<{ confirmed: number }> {
  if (receipt.unconfirmed.length > 0) {
    return refuse(
      "unconfirmed_revocation",
      `${receipt.unconfirmed.length} provider revocation(s) are unconfirmed: ${receipt.unconfirmed.join(", ")}`,
    );
  }
  return { outcome: "authorized", confirmed: receipt.outstandingApprovals.length + 1 };
}

/**
 * "Disconnect payments", in the order the plan requires: block new local
 * dispatch first, then enumerate what is still outstanding, then report
 * which provider-side revocations are not yet confirmed. It never claims a
 * revocation succeeded because a request was sent.
 */
export function disconnectAgentPayments(
  authority: AgentPaymentAuthority,
  outstandingApprovals: readonly { approvalId: string; revision: number; paymentMethodRef: string; credentialRef?: string; signerRef?: string }[],
  unconfirmed: readonly string[],
  now: number,
): AgentPaymentDecision<{ receipt: AgentRevocationReceipt }> {
  if (authority.dispatchBlocked) {
    return refuse("dispatch_already_blocked", "new dispatch is already blocked for this account");
  }
  authority.dispatchBlocked = true;
  const outstanding = outstandingApprovals.map((approval) => `${approval.approvalId}#${approval.revision}`);
  return {
    outcome: "authorized",
    receipt: {
      kind: "payment_method",
      reference: "local_dispatch",
      at: now,
      unconfirmed: [...unconfirmed],
      outstandingApprovals: outstanding,
      unreconciledMints: [...unconfirmed],
      dispatchBlocked: true,
    },
  };
}

export interface AgentRestoreSession {
  signedIn: boolean;
  deviceId: string;
}

export interface AgentAuthorityRestore {
  authority: AgentPaymentAuthority;
  /** What survives a restore, named honestly: the identity of unresolved
   * money, not the right to spend it again. */
  preservedReservations: readonly string[];
  /** Always empty. A restore never reconnects a payment method, credential
   * or signer. */
  reconnected: readonly string[];
  restoredAt: number;
}

/** Restore after sign-in, workspace restore or device replacement. It
 * reconnects NOTHING: revoked spending rights do not come back with a backup,
 * and a replacement device is a new device. */
export function restoreAgentPaymentAuthority(
  previous: AgentPaymentAuthority,
  session: AgentRestoreSession,
  preservedReservations: readonly string[],
  now: number,
): AgentPaymentDecision<AgentAuthorityRestore> {
  if (!session.signedIn) {
    return refuse("not_authenticated", "a signed-out session restores no payment authority");
  }
  if (session.deviceId !== previous.boundDeviceId) {
    return refuse("device_replaced", "a replacement device needs fresh, per-connection approval");
  }
  return {
    outcome: "authorized",
    authority: {
      ownerId: previous.ownerId,
      boundDeviceId: previous.boundDeviceId,
      paymentMethods: [],
      mintedCredentials: [],
      signers: [],
      dispatchBlocked: previous.dispatchBlocked,
    },
    preservedReservations: [...preservedReservations],
    reconnected: [],
    restoredAt: now,
  };
}

// ── the untrusted wire input, decoded once at the boundary ────────────

const purchaseRequestSchema = z.object({
  approvalId: z.string(),
  approvalRevision: z.number().int().positive(),
  ownerId: z.string(),
  taskId: z.string(),
  deviceId: z.string(),
  claimedBuyerId: z.string().optional(),
  providerId: z.string(),
  environment: z.enum(["sandbox", "production"]),
  rail: z.string(),
  paymentMethodRef: z.string(),
  payee: z.string(),
  origin: z.string(),
  itemDigest: z.string(),
  amountMinorUnits: z.number(),
  currency: z.string(),
  recurring: z.boolean(),
  executorId: z.string(),
});

/** Parse a wire-shaped purchase request into the domain type, or refuse. A
 * malformed body never reaches the authorization rules. */
export function parseAgentPurchaseRequest(
  input: {
    approvalId?: unknown;
    approvalRevision?: unknown;
    ownerId?: unknown;
    taskId?: unknown;
    deviceId?: unknown;
    claimedBuyerId?: unknown;
    providerId?: unknown;
    environment?: unknown;
    rail?: unknown;
    paymentMethodRef?: unknown;
    payee?: unknown;
    origin?: unknown;
    itemDigest?: unknown;
    amountMinorUnits?: unknown;
    currency?: unknown;
    recurring?: unknown;
    executorId?: unknown;
  },
): AgentPaymentDecision<{ request: AgentPurchaseRequest }> {
  const parsed = purchaseRequestSchema.safeParse(input);
  if (!parsed.success) {
    return refuse("amount_not_integer_minor_units", `malformed purchase request: ${parsed.error.issues[0]?.message ?? "unreadable"}`);
  }
  const rail = parsed.data.rail;
  if (!isAgentPaymentRailValue(rail)) {
    return refuse("rail_not_permitted", `rail ${rail} is not a known rail`);
  }
  return {
    outcome: "authorized",
    request: {
      ...parsed.data,
      rail,
      amountMinorUnits: requireIntegerMinorUnits(parsed.data.amountMinorUnits, "amountMinorUnits"),
    },
  };
}

function isAgentPaymentRailValue(value: string): value is AgentPaymentRail {
  return (
    value === "visa_intelligent_commerce" ||
    value === "mastercard_agent_pay" ||
    value === "encrypted_card_fallback" ||
    value === "provider_checkout" ||
    value === "wallet_transfer" ||
    value === "x402_http_challenge" ||
    value === "mpp_evm"
  );
}
