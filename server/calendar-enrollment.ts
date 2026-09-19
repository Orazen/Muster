import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { CallScope } from "./foreground-call.ts";
import type { IssuedCalendarDeviceGrant } from "./calendar-device-grants.ts";

export const CALENDAR_ENROLLMENT_TTL_MS = 5 * 60_000;
const MAX_ENROLLMENTS = 1000;
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const codeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/);
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const idSchema = z.string().uuid();
const accountSchema = z.string().min(1).max(1024);
export interface CalendarEnrollmentBinding {
  ownerId: string | null; botId: string; threadId: string; callId: string; callTokenHash: string; callInstanceId: string;
}
export interface CalendarEnrollmentView {
  id: string; botId: string; threadId: string; callId: string; expiresAt: number;
  state: "waiting" | "approving" | "ready" | "consumed" | "cancelled" | "expired";
}
export interface CalendarEnrollmentStart extends CalendarEnrollmentView { code: string }
export interface CalendarEnrollmentDelivery { enrollment: CalendarEnrollmentView; issued?: IssuedCalendarDeviceGrant }
export interface CalendarEnrollmentOptions {
  assertCallCurrent(binding: CalendarEnrollmentBinding): void;
  revoke(accountId: string, grantId: string): void;
  isPermissionCurrent(accountId: string, issued: IssuedCalendarDeviceGrant): boolean;
  now?: () => number;
}
export class CalendarEnrollmentError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
interface Entry { issuing?: boolean; binding: CalendarEnrollmentBinding; view: CalendarEnrollmentView; code: string; approvedBy?: string; issued?: IssuedCalendarDeviceGrant }
interface Failures { count: number; expiresAt: number }
const pending = (entry: Entry) => ["waiting", "approving", "ready"].includes(entry.view.state);
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
function fail(status: number, message: string): never { throw new CalendarEnrollmentError(status, message); }

/** Five-minute handoff only. Browser approval grants no general session and
 * device delivery is single-use: a lost response must not replay credentials.
 */
export class CalendarEnrollmentRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly failures = new Map<string, Failures>();
  private globalFailures: Failures = { count: 0, expiresAt: 0 };
  private readonly now: () => number;
  private readonly options: CalendarEnrollmentOptions;
  constructor(options: CalendarEnrollmentOptions) { this.options = options; this.now = options.now ?? Date.now; }
  private view(entry: Entry): CalendarEnrollmentView { return { ...entry.view }; }
  private cleanup(entry: Entry): void {
    if (!entry.issued || !entry.approvedBy) return;
    try { this.options.revoke(entry.approvedBy, entry.issued.grant.id); }
    catch { fail(503, "The enrollment permission could not be cleaned up. Try again."); }
    entry.issued = undefined;
  }
  private invalidate(entry: Entry, state: "expired" | "cancelled"): void {
    if (entry.view.state !== "consumed") entry.view.state = state;
    this.cleanup(entry);
  }
  private permissionCurrent(entry: Entry): void {
    if (!entry.issued || !entry.approvedBy) fail(409, "This enrollment permission is unavailable.");
    let current = false;
    try { current = this.options.isPermissionCurrent(entry.approvedBy, entry.issued); } catch { /* fail closed */ }
    if (!current) {
      this.invalidate(entry, "cancelled");
      fail(409, "Calendar permission changed. Start a new enrollment.");
    }
  }
  private current(entry: Entry): void {
    if (entry.view.expiresAt <= this.now()) this.invalidate(entry, "expired");
    if (!pending(entry)) fail(409, "This enrollment is no longer active. Start a new enrollment.");
    try { this.options.assertCallCurrent({ ...entry.binding }); }
    catch { this.invalidate(entry, "cancelled"); fail(409, "The original call is no longer current."); }
  }
  private scope(scope: CallScope, id: string): Entry {
    if (!idSchema.safeParse(id).success || !tokenSchema.safeParse(scope.token).success) fail(404, "Enrollment not found.");
    const entry = this.entries.get(id);
    if (!entry || entry.binding.ownerId !== scope.ownerId || entry.binding.botId !== scope.botId || entry.binding.callTokenHash !== digest(scope.token)) fail(404, "Enrollment not found.");
    return entry;
  }
  private checkLimit(accountId: string): void {
    if (!accountSchema.safeParse(accountId).success) fail(404, "Enrollment not found.");
    const now = this.now();
    for (const [account, value] of this.failures) if (value.expiresAt <= now) this.failures.delete(account);
    if (this.globalFailures.expiresAt <= now) this.globalFailures = { count: 0, expiresAt: now + 60_000 };
    if ((this.failures.get(accountId)?.count ?? 0) >= 20 || this.globalFailures.count >= 100 || (!this.failures.has(accountId) && this.failures.size >= 1000)) {
      fail(429, "Too many enrollment attempts. Try again later.");
    }
  }
  private failed(accountId: string): never {
    const counter = this.failures.get(accountId) ?? { count: 0, expiresAt: this.now() + 60_000 };
    counter.count++; this.failures.set(accountId, counter); this.globalFailures.count++;
    fail(404, "Enrollment not found.");
  }
  private browser(code: string, accountId: string): Entry {
    this.checkLimit(accountId);
    if (!codeSchema.safeParse(code).success) return this.failed(accountId);
    const entry = [...this.entries.values()].find(value => value.code === code);
    if (!entry || (entry.binding.ownerId !== "local" && entry.binding.ownerId !== accountId)) return this.failed(accountId);
    this.current(entry);
    return entry;
  }
  start(scope: CallScope, rawBinding: CalendarEnrollmentBinding, requestId: string): CalendarEnrollmentStart {
    const { callId, threadId, callInstanceId } = rawBinding;
    if (!idSchema.safeParse(callId).success || !idSchema.safeParse(callInstanceId).success || !idSchema.safeParse(requestId).success || !tokenSchema.safeParse(scope.token).success ||
      !accountSchema.safeParse(scope.ownerId).success || !accountSchema.safeParse(scope.botId).success || !accountSchema.safeParse(threadId).success) fail(400, "Invalid enrollment request.");
    if (rawBinding.ownerId !== scope.ownerId || rawBinding.botId !== scope.botId || rawBinding.callTokenHash !== digest(scope.token)) fail(404, "Enrollment not found.");
    this.sweep();
    const binding: CalendarEnrollmentBinding = { ownerId: scope.ownerId, botId: scope.botId, threadId, callId, callTokenHash: digest(scope.token), callInstanceId };
    try { this.options.assertCallCurrent(binding); } catch { fail(409, "The original call is no longer current."); }
    if (this.entries.has(requestId)) {
      const entry = this.scope(scope, requestId);
      if (entry.binding.callId !== callId || entry.binding.threadId !== threadId || entry.binding.callInstanceId !== callInstanceId) fail(409, "This enrollment identifier was already used.");
      return { ...this.view(entry), code: entry.code };
    }
    if ([...this.entries.values()].some(entry => pending(entry) && entry.binding.callId === callId && entry.binding.botId === scope.botId && entry.binding.ownerId === scope.ownerId)) fail(409, "An enrollment is already pending for this call.");
    if (this.entries.size >= MAX_ENROLLMENTS) fail(429, "Too many pending enrollments. Try again later.");
    let code = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      code = [...randomBytes(8)].map(byte => CODE_ALPHABET[byte & 31]).join("");
      if (![...this.entries.values()].some(entry => entry.code === code)) break;
      code = "";
    }
    if (!code) fail(503, "An enrollment code could not be created. Try again.");
    const entry: Entry = { binding, code, view: { id: requestId, botId: scope.botId, threadId, callId, state: "waiting", expiresAt: this.now() + CALENDAR_ENROLLMENT_TTL_MS } };
    this.entries.set(requestId, entry);
    return { ...this.view(entry), code };
  }
  inspect(code: string, accountId: string): CalendarEnrollmentView { return this.view(this.browser(code, accountId)); }
  async approve(code: string, accountId: string, issue: () => Promise<IssuedCalendarDeviceGrant>): Promise<CalendarEnrollmentView> {
    const entry = this.browser(code, accountId);
    if (entry.view.state !== "waiting") fail(409, "This enrollment was already approved or is being approved.");
    entry.view.state = "approving";
    entry.approvedBy = accountId;
    entry.issuing = true;
    let issued: IssuedCalendarDeviceGrant;
    try { issued = await issue(); }
    catch {
      entry.issuing = false;
      if (entry.view.state === "approving") entry.view.state = "cancelled";
      fail(502, "Calendar permission could not be issued. Start a new enrollment.");
    }
    entry.issued = issued;
    entry.issuing = false;
    // Cancellation/expiry can run while issuance waits. Cleanup uses the exact
    // approving account and issued grant, never a current/replacement account.
    try {
      this.current(entry);
      this.permissionCurrent(entry);
      if (entry.view.state !== "approving" || this.entries.get(entry.view.id) !== entry) fail(409, "This enrollment is no longer active.");
    } catch (error) { this.invalidate(entry, this.view(entry).state === "expired" ? "expired" : "cancelled"); throw error; }
    entry.view.state = "ready";
    return this.view(entry);
  }
  take(scope: CallScope, id: string, expectedCallId: string): CalendarEnrollmentDelivery {
    const entry = this.scope(scope, id);
    if (entry.binding.callId !== expectedCallId) fail(404, "Enrollment not found.");
    this.current(entry);
    if (entry.view.state !== "ready") return { enrollment: this.view(entry) };
    this.permissionCurrent(entry);
    const issued = entry.issued;
    if (!issued) fail(409, "This enrollment is no longer available.");
    entry.issued = undefined;
    entry.view.state = "consumed";
    return { enrollment: this.view(entry), issued: { token: issued.token, grant: { ...issued.grant } } };
  }
  cancel(scope: CallScope, id: string, expectedCallId: string): CalendarEnrollmentView {
    const entry = this.scope(scope, id);
    if (entry.binding.callId !== expectedCallId) fail(404, "Enrollment not found.");
    this.invalidate(entry, "cancelled");
    return this.view(entry);
  }
  sweep(): void {
    for (const [id, entry] of this.entries) {
      if (entry.view.expiresAt <= this.now()) {
        this.invalidate(entry, "expired");
        if (!entry.issued && !entry.issuing) this.entries.delete(id);
      } else if (pending(entry)) {
        try { this.options.assertCallCurrent({ ...entry.binding }); }
        catch { this.invalidate(entry, "cancelled"); }
      } else if (entry.issued) {
        this.cleanup(entry);
      }
    }
  }
}
