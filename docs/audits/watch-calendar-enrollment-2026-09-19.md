# Watch Calendar enrollment and review — Loop143

## Flow

An accepted foreground Watch call can request a five-minute approval code.
The signed-in user opens Calendar settings on that same connected computer,
inspects the bot and expiry, selects an available calendar and explicitly approves
24-hour read-only planning access. The Watch checks approval and receives the
permission once, through its original call. No credential appears in the code,
URL, browser response, transcript or UI. The permission is stored in Keychain
scoped to the exact paired connection and credential fingerprint.

The Watch reviews the selected calendar, date/timezone, work hours and one to
three priorities/durations. Prepare fills a reviewable draft; Send remains a
separate action. Successful preparation collapses the form to keep review and
Send reachable. The generic calendar prompt is replaced by this explicit flow.

## Invariants

- Pending enrollment binds owner, bot, thread, call ID, internal call instance
  and call-capability hash. Reusing a call ID/token cannot revive an old request.
- Only the original call can check/cancel enrollment. Hosted approval requires
  its actual owner account. Local approval requires a real signed-in account;
  installation ownership never chooses a Google account implicitly.
- Codes expire after five minutes. Attempts and total pending records are bounded;
  approval is claimed before async work, and ready delivery is single-use.
  A lost delivery receipt requires a new enrollment, never replayed credentials.
- Cancellation, call replacement/expiry and permission revocation discard pending
  results. A grant issued after cancellation is revoked using the captured owner.
  The server's unref'd 30-second sweep cleans abandoned requests and retries failed
  cleanup without making cancelled credentials deliverable.
- Native context/generation and draft checks reject stale results. Preparing does
  not send work. Call lease reads continue while the foreground form is open.
- Local desktop and muster.today have separate account/grant databases. This flow
  requires approval on the Watch's connected host; it is not cross-host sync.

## Verification and corrections

Focused HTTP integration:61/61 across three files, including real registry,
account permission, one-time delivery and calendar preparation without dispatch.
Enrollment registry:19/19 including failed-revocation retry before expiry.
Companion enrollment allowlist:160/160, preserving stripped credentials and
full-access gating. Optional offline Calendar fixture:10/10 real HTTP tests.

Owned browser enrollment covers code normalization, no automatic approval,
changed-code response rejection, explicit selection/approval, revocation and320px.
Initial test failures were a stale bundle and a corrected select locator. Fresh
focused enrollment1/1 and existing Calendar5/5 passed. A full browser run follows.

Independent review reproduced/planned regression coverage for concurrent native
reconnect during delayed cancellation and editing inputs during preparation.
Both were fixed and covered by the native tests below. The first native build
also overlapped a form-callback change and hit a mixed-source linker error;
final frozen-source builds supersede that compile attempt, not its failure record.

Provider/Calendar data is synthetic and outbound networking is denied. This does
not prove real Google consent, wrist audio, hardware or cross-device recovery.
Final combined gates and native interaction results follow when terminal.

Native review corrections are implemented: reserve replacement enrollment busy/
generation before awaiting cancellation; reject replaced operations; validate
request identity and future expiry of the start receipt. Planning inputs and
add/remove controls are disabled while preparing; Cancel/End remain available.
The selected calendar ID is displayed separately from the permission's device
label. Final focused native34/34 and full Swift390/390 passed, zero failures.
Log:`/tmp/muster-enrollment-full-final.log`. Final-source build/UI receipts pending.

Final-source simulator builds: WatchOwnedAcceptance, MusterCompanion and
MusterFleetWidget all exited 0. The first owned UI attempt failed before Calendar
enrollment: XCTest typed into the pairing-address editor before keyboard focus
was established. Its receipt is retained; it is not a passing Calendar test.
Source revisions advanced independently during verification through 6576129
(release-agent security-policy/dependency configuration and deployment triggers);
those unrelated changes are preserved and are outside this slice.

Fresh full browser gate: **40/40 passed**, 6.5 minutes, zero failures.
Log: `/tmp/muster-loop143-browser.log`; owned backup fixture cleanup reports
process exit, closed ports, outbound deny and temporary root removal.
Both TypeScript checks and full lint exited 0. Production GET still reports
backend `7632065f-88c9-4614-8faa-42adb590f61b` and web
`453b2f23-e6ce-4963-ad5b-c5d09ac598a6`, null revisions and no attestation;
this slice has no deployment receipt.

Final full unit: **317 files /4734 passed /8 skipped /0 failed**,635.98s.
Delta from Loop142: +2 files, +32 passing. Log `/tmp/muster-loop143-full.log`.
Final-source Watch XCTest **1/1 passed**,147.407s, zero failures: approval
through real host endpoints, event/priority provenance, zero pre-Send dispatch,
one explicit message/reply and End. Provider data remains synthetic.
Final UI scratch: `/var/folders/j2/99fjlfmx07l3vvgrky5lp96m0000gn/T/muster-watch-call-04vUJB`.
Outer native helper exited 0. Host action counts: enrollment1, status1,
prepare1, messages1, end1; call GET15. Both owned simulators were deleted
(33DBBAF4-6C54-46D8-8735-A40088E16B9F and F62737E4-7681-4A10-BAF9-6BF803FD1FE5).
Ports49376/49377/53087/53088 refused connections after cleanup.
Representative inspected screenshot: `/tmp/muster-loop143-final-attachments/8D70CB2C-1806-436B-B4A4-D36A26EFB8E3.png`.
No user simulator, installed application, existing service or demo8845 was changed.
