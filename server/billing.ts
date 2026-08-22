/**
 * Billing — free self-host, paid cloud.
 *
 * The model is Dokploy's, and so is the shape: this file ships in the
 * open-source repo but is *inert* unless MUSTER_CLOUD=true. Self-hosters are
 * never asked for a license key and no feature is withheld from them. What is
 * sold is the hosting, not the software. Every export below returns
 * null/no-op when IS_CLOUD is false, so the call sites need no branching.
 *
 * Dependency-free on purpose: this talks to Stripe's REST API with `fetch`
 * rather than the `stripe` SDK. The harness is bundled into an Electron app
 * and a Docker image where, for the overwhelming majority of users, none of
 * this code ever runs — a payments SDK in that bundle is pure weight.
 *
 * The metered unit is the **cloud computer** (the Linux desktop a bot drives),
 * not the bot. Bots are free to create and cost nothing until one gets hands,
 * so charging per bot would bill people for something that consumes nothing.
 * This maps onto Stripe's quantity-based subscription items the same way
 * Dokploy meters servers.
 *
 * Stripe remains the source of truth for subscription state. Nothing here
 * caches "is this customer paid" into our own database, because that cache is
 * exactly what goes stale when a card fails at 3am.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { PUBLIC_BASE_URL } from "./auth.ts";
import { sendEmail } from "./email.ts";
import type { JsonValue } from "./schema.ts";

/** Single switch, mirroring Dokploy's IS_CLOUD. Absent everywhere else. */
export const IS_CLOUD = process.env.MUSTER_CLOUD === "true";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY?.trim();
/**
 * Read at call time, not module load: the Docker entrypoint and some hosting
 * panels populate the environment after this module is first imported, and a
 * value captured at load time would be permanently empty.
 */
const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET?.trim();
const STRIPE_PRICE_MONTHLY = process.env.STRIPE_PRICE_MONTHLY?.trim();
const STRIPE_PRICE_ANNUAL = process.env.STRIPE_PRICE_ANNUAL?.trim();

const STRIPE_API = "https://api.stripe.com/v1";

/** True when the cloud tier is switched on *and* fully configured. */
export function isBillingConfigured(): boolean {
  return IS_CLOUD && Boolean(STRIPE_SECRET_KEY) && Boolean(STRIPE_PRICE_MONTHLY);
}

/**
 * Stripe's API is form-encoded, including nested structures, which it expects
 * as `parent[child]` and `list[0][field]`. Flatten a plain object into that.
 */
// Objects and arrays both recurse into indexed form fields; an array is
// an object here, which is exactly what Object.entries walks by index.
const isFormSection = (value: JsonValue): value is Record<string, JsonValue> =>
  value !== null && value instanceof Object;

function toFormBody(input: Record<string, JsonValue>, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (isFormSection(item)) {
          parts.push(...toFormBody(item, `${name}[${index}]`));
        } else {
          parts.push(`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else if (isFormSection(value)) {
      parts.push(...toFormBody(value, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts;
}

async function stripeRequest<T>(
  method: "GET" | "POST",
  path: string,
  params?: Record<string, JsonValue>,
): Promise<T> {
  if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");

  const body = params ? toFormBody(params).join("&") : undefined;
  const url = method === "GET" && body ? `${STRIPE_API}${path}?${body}` : `${STRIPE_API}${path}`;

  const headers = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Stripe-Version": "2024-09-30.acacia",
  };
  const init: RequestInit = { method, headers };
  // Only POST carries the encoded params as a body; GET puts them in the URL.
  if (method === "POST" && body) init.body = body;

  const res = await fetch(url, init);

  // SAFETY: Stripe answers every endpoint with a JSON envelope; only the
  // error message field is read here and both may be absent.
  const payload = (await res.json()) as { error?: { message?: string } };
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} failed (${res.status}): ${payload.error?.message ?? "unknown"}`);
  }
  // SAFETY: T is the caller's declared slice of this Stripe response; the
  // fields each caller reads are optional on their interfaces.
  return payload as T;
}

interface StripeList<T> {
  data: T[];
}
interface StripeCustomer {
  id: string;
}
interface StripeSubscriptionItem {
  id: string;
  quantity?: number;
  price?: { id: string; unit_amount?: number | null; recurring?: { interval?: string } | null };
}
interface StripeSubscription {
  id: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  items: StripeList<StripeSubscriptionItem>;
}

/**
 * One Stripe customer per Muster user, looked up by the `musterUserId`
 * metadata field rather than by email — emails change, and a search by email
 * would silently attach a second customer to the same person.
 */
async function findOrCreateCustomer(userId: string, email: string): Promise<string> {
  const found = await stripeRequest<StripeList<StripeCustomer>>("GET", "/customers/search", {
    query: `metadata['musterUserId']:'${userId}'`,
    limit: 1,
  });
  const existing = found.data[0];
  if (existing) return existing.id;

  const created = await stripeRequest<StripeCustomer>("POST", "/customers", {
    email,
    metadata: { musterUserId: userId },
  });
  return created.id;
}

export interface SubscriptionSummary {
  status: "active" | "trialing" | "past_due" | "canceled" | "none";
  /** Metered cloud computers on the plan. */
  quantity: number;
  interval: "month" | "year" | null;
  /** Unix seconds; when the current period ends or the cancellation lands. */
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

const NO_SUBSCRIPTION: SubscriptionSummary = {
  status: "none",
  quantity: 0,
  interval: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

/**
 * Current subscription for a user, straight from Stripe.
 *
 * Returns null — not an error — when self-hosting. Callers use that to mean
 * "billing does not apply here", which is the free-and-unlimited case.
 */
export async function getSubscription(
  userId: string,
  email: string,
): Promise<SubscriptionSummary | null> {
  if (!isBillingConfigured()) return null;

  try {
    const customerId = await findOrCreateCustomer(userId, email);
    const subs = await stripeRequest<StripeList<StripeSubscription>>("GET", "/subscriptions", {
      customer: customerId,
      status: "all",
      limit: 1,
      expand: ["data.items.data.price"],
    });

    const sub = subs.data[0];
    if (!sub) return NO_SUBSCRIPTION;

    const live = sub.status === "active" || sub.status === "trialing";
    if (!live && sub.status !== "past_due") return NO_SUBSCRIPTION;

    const item = sub.items.data[0];
    const interval = item?.price?.recurring?.interval;

    // SAFETY: the early returns above leave only active, trialing, or
    // past_due — exactly the statuses SubscriptionSummary carries.
    return {
      status: sub.status as SubscriptionSummary["status"],
      quantity: item?.quantity ?? 0,
      interval: interval === "year" ? "year" : interval === "month" ? "month" : null,
      currentPeriodEnd: sub.current_period_end ?? null,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    };
  } catch (error) {
    console.error("[billing] could not read subscription:", error instanceof Error ? error.message : error);
    return NO_SUBSCRIPTION;
  }
}

/**
 * Gate for metered actions (provisioning a cloud computer). Returns null when
 * the action may proceed — self-hosting (null subscription means "billing
 * does not apply") or a live subscription — or a user-facing reason when the
 * subscription is missing, past due, or canceled.
 */
export function provisioningBlocked(sub: SubscriptionSummary | null): string | null {
  if (sub === null) return null; // self-hosting: free and unlimited
  if (sub.status === "active" || sub.status === "trialing") return null;
  if (sub.status === "past_due") {
    return "your subscription payment failed — update your card in Settings → Billing to keep provisioning cloud computers";
  }
  return "no active subscription — subscribe in Settings → Billing to provision cloud computers";
}

/** A value that is genuinely a string — the dunning-address check. */
const isText = <T>(value: T): value is T & string => String(value) === value;

/** Read the subscription item id + current quantity, in one call. */
async function subscriptionItem(
  userId: string,
  email: string,
): Promise<{ id: string; quantity: number } | null> {
  const customerId = await findOrCreateCustomer(userId, email);
  const subs = await stripeRequest<StripeList<StripeSubscription>>("GET", "/subscriptions", {
    customer: customerId,
    status: "all",
    limit: 1,
    expand: ["data.items.data.price"],
  });
  const item = subs.data[0]?.items.data[0];
  if (!item || !subs.data[0] || !["active", "trialing", "past_due"].includes(subs.data[0].status)) {
    return null;
  }
  return { id: item.id, quantity: item.quantity ?? 0 };
}

/**
 * Count one more metered cloud computer on the subscription. Called
 * fire-and-forget after a successful provision: Stripe stays the source of
 * truth, and the Billing Portal remains where customers can adjust down.
 */
export async function bumpSubscriptionQuantity(userId: string, email: string, by = 1): Promise<boolean> {
  if (!isBillingConfigured()) return false;
  try {
    const item = await subscriptionItem(userId, email);
    if (!item) return false;
    await stripeRequest("POST", `/subscription_items/${item.id}`, {
      quantity: item.quantity + by,
    });
    return true;
  } catch (error) {
    console.error("[billing] could not sync quantity:", error instanceof Error ? error.message : error);
    return false;
  }
}

/** Hosted Stripe Checkout URL for a new subscription. */
export async function createCheckoutSession(opts: {
  userId: string;
  email: string;
  interval: "month" | "year";
  quantity: number;
  returnUrl: string;
}): Promise<string | null> {
  if (!isBillingConfigured()) return null;

  const price = opts.interval === "year" ? STRIPE_PRICE_ANNUAL : STRIPE_PRICE_MONTHLY;
  if (!price) throw new Error(`no Stripe price configured for interval "${opts.interval}"`);

  const customerId = await findOrCreateCustomer(opts.userId, opts.email);
  const session = await stripeRequest<{ url: string }>("POST", "/checkout/sessions", {
    mode: "subscription",
    customer: customerId,
    line_items: [{ price, quantity: Math.max(1, opts.quantity) }],
    // Lets a customer change the count from inside Checkout rather than
    // bouncing back here to redo it.
    "line_items[0][adjustable_quantity][enabled]": "true",
    "line_items[0][adjustable_quantity][minimum]": "1",
    success_url: `${opts.returnUrl}?checkout=success`,
    cancel_url: `${opts.returnUrl}?checkout=cancelled`,
    client_reference_id: opts.userId,
    subscription_data: { metadata: { musterUserId: opts.userId } },
  });
  return session.url;
}

/**
 * Stripe-hosted billing portal. Card updates, invoices, plan changes and
 * cancellation all live there, so none of it has to be built or maintained
 * here — and none of it touches card data on our side.
 */
export async function createPortalSession(opts: {
  userId: string;
  email: string;
  returnUrl: string;
}): Promise<string | null> {
  if (!isBillingConfigured()) return null;

  const customerId = await findOrCreateCustomer(opts.userId, opts.email);
  const session = await stripeRequest<{ url: string }>("POST", "/billing_portal/sessions", {
    customer: customerId,
    return_url: opts.returnUrl,
  });
  return session.url;
}

/**
 * Verify Stripe's `Stripe-Signature` header against the raw request body.
 *
 * This has to run on the *raw* bytes — parsing and re-serialising the JSON
 * changes key order and whitespace, and the signature no longer matches. The
 * comparison is constant-time, and the timestamp is checked against a
 * five-minute window so a captured payload cannot be replayed later.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const secret = webhookSecret();
  if (!secret || !signatureHeader) return false;

  const parts = new Map(
    signatureHeader.split(",").map((pair) => {
      const index = pair.indexOf("=");
      return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()] as const;
    }),
  );

  const timestamp = parts.get("t");
  const signature = parts.get("v1");
  if (!timestamp || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Handle a verified webhook.
 *
 * Subscription state is deliberately *not* mirrored into our database — every
 * read goes to Stripe. So these events are for side effects (notifying the
 * customer, logging) rather than for keeping a local copy in sync.
 */
export function handleWebhookEvent(event: { type: string; data?: { object?: unknown } }): void {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      console.log(`[billing] ${event.type}`);
      break;
    case "invoice.payment_failed": {
      // Worth surfacing loudly: the customer is about to lose access. Dunning
      // mail goes out here so a failed card gets one clear, actionable notice;
      // Stripe's own retries keep retrying quietly in the background.
      console.warn("[billing] invoice.payment_failed — subscription at risk");
      // SAFETY: Stripe's invoice object carries customer_email as a string or
      // null; anything else only means no dunning mail goes out.
      const invoice = event.data?.object as { customer_email?: string | null } | undefined;
      const to = isText(invoice?.customer_email) ? invoice.customer_email : null;
      if (to) {
        void sendEmail({
          to,
          subject: "Action needed: your Muster payment failed",
          text:
            "Your latest Muster subscription payment failed. " +
            "Cloud computer provisioning pauses until the balance is settled — your bots and data are untouched. " +
            `Update your card at ${PUBLIC_BASE_URL}/app/settings/billing.`,
        }).catch((error) => {
          console.error("[billing] dunning email failed:", error instanceof Error ? error.message : error);
        });
      }
      break;
    }
    case "invoice.payment_succeeded":
      console.log("[billing] invoice.payment_succeeded");
      break;
    default:
      // Stripe sends far more event types than we subscribe to; ignoring the
      // rest quietly is correct, and returning 200 stops Stripe retrying.
      break;
  }
}
