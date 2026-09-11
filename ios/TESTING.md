# Testing the companion locally

The automated stages have been run on a Mac and simulator, and the network
stages on an iPhone. Keep this as the runbook for the next machine and release.

Stages, cheapest signal first. Each one is worth completing before starting the
next — a Swift compile error found in stage 1 costs a minute, the same error
found while chasing a Bonjour problem on a phone costs an hour. Stage 5 is the
way out when the network itself is the problem.

## What you need

| Stage | Needs |
|---|---|
| 1 — core tests | a Mac with Xcode command line tools (`xcode-select --install`) |
| 2 — desktop half | + Node 24+, pnpm, and one agent CLI (`claude`, `codex`, or `grok`) signed in |
| 3 — simulator | + full Xcode and XcodeGen |
| 4 — end to end | + an iPhone on the same Wi-Fi as the Mac |
| 5 — off this network | + Tailscale on both, same account |

Stages 1 and 2 are worth doing even if you never get to a phone: stage 1 is
where the Swift errors are, and stage 2 exercises the companion listener the
desktop app now ships.

---

## Stage 0 — get the code

Use current `main` after the companion lands. While reviewing the feature PR,
GitHub CLI can create the correct local branch:

```sh
git clone https://github.com/Orazen/Muster
cd Muster
gh pr checkout 161        # omit after the PR is merged
```

Sanity check — `ios/` and the companion sidecar should be present:

```sh
ls ios/Sources/CompanionCore companion/src/devices.ts companion/src/mdns.ts
```

---

## Stage 1 — the core compiles and its tests pass

No full Xcode, simulator, or phone is required. This is the cheapest place to
catch wire-model, parser, and state-fold regressions.

```sh
cd ios
swift build
swift test
```

`Sources/` is the only product `swift test` builds; `App/` is compiled in
stage 3.

A trailing `Test run with 0 tests in 0 suites passed` is expected and not a
problem: that is swift-testing finding none of its own tests, because these are
XCTest.

**What passing means.** The decoding tests read
`Tests/CompanionCoreTests/Fixtures/*.json`, which were captured from a real
running harness. Green means the client agrees with what the server actually
sends — not with anyone's memory of it.

If a decoding test fails while the others pass, suspect the fixture is stale
before suspecting the model: re-capture with
`node scripts/capture-companion-fixtures.mjs` from the repo root and read the
diff.

---

## Stage 2 — the desktop side, on its own

Prove the harness half works before a phone is in the picture.

```sh
pnpm install
pnpm build:companion      # required once before the dev toggle can start it
pnpm dev                  # 127.0.0.1:5199
pnpm dev:desktop          # Electron starts the harness
```

In the app: **Settings → Companion**. Turn it on. You should see either

- *"Your phone will find this computer as …"* — Bonjour is advertising, or
- *"Listening on 192.168.x.x:8810 — enter that on your phone."* — it is not.

Both are workable; the second just means typing an address. Then **Start
pairing** and check the six-digit code counts down and cancels cleanly.

Verify from a second terminal that the socket is real and refuses strangers:

```sh
curl -s http://192.168.x.x:8810/api/bots            # expect 401 + "pair this device…"
curl -s http://127.0.0.1:8811/state | jq            # addresses, pairing, devices, discovery
dns-sd -B _muster._tcp                         # macOS: should list the service
```

### If discovery says it is not advertising

This is the likeliest snag on macOS, and it is not a bug in the phone.

- **Port 5353 is owned by mDNSResponder.** The sidecar asks for `SO_REUSEADDR`
  and normally shares it fine, but if something else grabbed it exclusively the
  advertisement cannot start. `sudo lsof -i :5353` shows who.
- **The firewall is prompting.** System Settings → Network → Firewall. Incoming
  connections to `node`/Muster must be allowed, or the phone reaches
  nothing on 8810 even with a correct address.
- Neither blocks testing: use the typed address instead. Discovery failing is
  designed to be a fallback, not a dead end — that is worth confirming too.

---

## Stage 3 — build and launch the simulator

```sh
brew install xcodegen
cd ios && xcodegen generate && open MusterCompanion.xcodeproj
```

Build for the simulator first — it is a faster loop for compile errors.
The same gate can run without opening Xcode:

```sh
xcodebuild -project MusterCompanion.xcodeproj \
  -scheme MusterCompanion \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  CODE_SIGNING_ALLOWED=NO build
```

**Re-run `xcodegen generate` whenever a pull adds a file to `App/`.** The
generated project lists source files explicitly, so a new one is missing from
the target until you regenerate, and the build fails with `Cannot find 'X' in
scope` — which looks like a code error and is not one.

### If the app is letterboxed inside black bars

Everything drawn oversized, content floating in the middle of the screen, black
above and below: that is iOS compatibility scaling, and it means the built
Info.plist has no `UILaunchScreen` key. Check the built product rather than the
spec — `plutil -p` the Info.plist inside the .app — because
`INFOPLIST_KEY_UILaunchScreen_Generation` is *silently ignored* for a target
that supplies its own Info.plist, which is how this shipped the first time.

Then switch to a **real device**. The simulator shares the Mac's network stack,
so Bonjour there proves less than it appears to, and the local-network
permission prompt behaves differently. Signing needs a free Apple ID team; no
paid account is required to run on your own phone.

---

## Stage 4 — the thing actually working

On the phone, in order:

1. **Pair.** In Muster → Settings → Companion, choose **Set up a
   phone**. Scan the QR code with the phone's Camera, open MusterMobile,
   confirm that the computer and six-digit code are filled in, then tap
   **Connect**. The computer should also appear by name for the manual path:
   tap it and type the same code.
   - Relaunch the app after pairing once. It should return to the roster
     without asking for another code; that proves the device token made it
     into Keychain rather than only living in memory.
   - If the list stays empty, check in this order:
     1. **Local Network permission.** iOS asks once, and a denial is
        permanent and silent. Settings → Muster → Local Network. If the
        toggle is not even there, the prompt never fired — which points at the
        Info.plist. Deleting the app and reinstalling resets the decision and
        asks again.
     2. **The built Info.plist** actually carries
        `NSLocalNetworkUsageDescription` and `NSBonjourServices`. Without them
        `NWBrowser` returns nothing at all, silently, and it looks exactly like
        an empty network: `plutil -p` the Info.plist inside the built .app.
     3. **The phone and the Mac are on the same Wi-Fi.** Check the actual
        SSID on both, not just "is Wi-Fi on" — one device on the guest network
        and the other on the main one is the single most common cause, and the
        two look identical from the phone. Bonjour is multicast: it does not
        cross subnets, and guest networks usually isolate clients from each
        other on top of that, which blocks the typed address too. Cellular
        carries no Bonjour either, so a phone that fell back to 5G finds
        nothing. Settings → Wi-Fi → ⓘ shows the phone's IP; if it is not on
        the same /24 as the Mac, that is the answer.
   - Then use the typed address as a fallback and keep going. Pairing by
     address exercises everything except discovery.
   - **If the typed address does not work either**, stop diagnosing the
     network and go to stage 5. When both devices are demonstrably on the
     same SSID and neither discovery nor a typed address gets through, the
     network is isolating its clients and there is nothing to fix on either
     machine.
2. **The roster loads**, matching what the desktop shows.
3. **Send a message** from the phone. It should appear on the desktop too — same
   harness, two clients.
4. **The approval.** This is the whole product. Ask a bot to do something that
   needs permission (`run \`ls\` in my home directory` is enough for most
   engines). The card should reach the phone; answering it there should
   unblock the bot on the laptop.
5. **Reconnect.** Background the app for a minute while the bot keeps working,
   then come back. The transcript should catch up *without* a visible reload —
   that is the resumable stream doing its job. Watch the harness log to confirm
   it replayed rather than re-hydrated.
6. **Revoke.** Remove the device in Settings → Companion on the computer. The
   phone should land on "This phone was unpaired" rather than silently failing.

---

## Stage 5 — off this network, via Tailscale

Everything above assumes the phone and the Mac can reach each other directly.
Sometimes they cannot, and no amount of checking the SSID fixes it: a guest
network that isolates its clients will let both devices online, show them the
same network name, and still drop every packet between them. Bonjour finds
nothing and the typed address times out, which reads exactly like a broken app.

Tailscale makes that class of problem go away rather than diagnosing it. Both
devices join a private network of your own and get an address in `100.64.0.0/10`
that does not depend on which Wi-Fi either of them is on — or on Wi-Fi at all,
so this is also how the phone reaches the Mac over cellular.

1. **On the Mac:** install Tailscale (`brew install --cask tailscale`, or the
   App Store build) and sign in.
2. **On the phone:** install Tailscale from the App Store, sign in to the *same*
   account, and turn the VPN on.
3. **In Muster → Settings → Companion:** with the toggle on, the panel now
   prints the tailnet name — something like `macbook.tail1234.ts.net:8810`, with
   the LAN address listed separately underneath. If it still only shows a
   `192.168.x.x` address, the sidecar could not find the Tailscale CLI — it
   asks once at startup, so turn the Companion toggle off and on again (or
   restart `pnpm companion` if running it by hand) after Tailscale is up.
4. **On the phone:** scan the Companion panel's QR code, which carries that
   MagicDNS name, or pair by typing the name. Discovery does not help here —
   Bonjour is multicast and a tailnet does not carry it — so the QR/manual
   address is the path, and it is the one path that works from anywhere.

**Use the name, not the address.** Both reach the harness, but only the name
gets past App Transport Security. iOS exempts local networking, and `100.64/10`
is CGNAT space rather than one of the private ranges that exemption covers, so
a plain-HTTP request to a bare tailnet address is refused by the OS before it
reaches the network. `ios/project.yml` exempts `ts.net` by name instead. The
symptom if you use the address anyway is a connection that fails instantly with
a policy error rather than a timeout.

Once paired over a tailnet, nothing else changes: the same stream, the same
approvals, the same reconnect behaviour. It is the same listener on the same
port — only the route to it is different.

---

## What is expected not to work

Not built yet, so not bugs:

- **Nothing arrives after the app is terminated.** Live and replayed notification
  frames now become native alerts and badges, but closed-app push still needs an
  APNs relay with project-owned Apple credentials.
- **No voice or routine management.** Tasks, SQLite transcript search/export,
  reactions, and edit/version switching are available from the conversation UI.

(Two entries that used to sit on this list have since shipped: replies stream
token by token as the provider emits them, and each bot has a computer panel —
open it from the chat and frames arrive for exactly as long as it is on
screen.)

## If the phone sits on "Connecting…"

The two sides now say what they think is happening, and comparing them is
usually the whole diagnosis:

- **Desktop/server log:** the sidecar and harness record the stream opening and
  closing. No opening entry means the request never arrived.
- **Xcode console**, subsystem `com.muster.companion`: `opening stream`,
  then `stream live, resumed=…`, then `hydrated N bots`. Whichever of those is
  missing is where it stopped.

Opened on the server but never live on the phone means the bytes are not
reaching the client. Never opened means the request never left it. A repeating
`opened` / `closed` pair on the server with `stream failed: cancelled` on the
phone means the client is tearing its own connection down — that was a real bug
(`URLSession.AsyncBytes` cancels its task when the sequence is released), and
`EventStreamTests` now guards against its whole class.

## Reporting back

For Swift errors, the compiler's own output is the most useful thing — file,
line, and message. For runtime problems, the harness log is usually more
informative than the phone: it is where the pairing, auth and stream decisions
are actually made.


## Native welcome-answer verification — 2026-09-11

CEO Loop43 records **161 Swift core tests passing** and **8 final native XCTest
cases passing** on a fresh iPhone SE3/iOS26.5 simulator. The cases pair with an
isolated real companion proxy/server and inspect real SQLite/SSE/driver receipts;
the provider itself is an explicit offline fixture. Google, a physical phone,
Watch runtime and App Store distribution are separate unverified gates.

The preserved owned test target/harness, frozen source, exact commands, hashes,
screenshots and failed runs are under
`.omb-scratch/verification/loop43-ios/`. No native UI test target is added to the
tracked XcodeGen specification. The companion's shared core remains runnable with
`swift test --package-path ios`; this is separate from root Vitest.

For native simulator behavior that accesses Keychain, use local ad hoc signing
(`CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES`). An
unsigned build compiled but failed real pairing-token storage because it lacked
the simulated application identity. This local build setting is not distribution
signing or a provisioning-profile test. Watch was compiled unsigned only.

The welcome editor must autofocus on both first opening and reopening, retain
exact multiline input after a failed request/Close, and keep Send above the actual
keyboard. Its focus callback runs once after native presentation; SwiftUI's early
onAppear was insufficient in this run. Card controls have a containing accessible
group so the parent identifier does not replace each button identifier. Select the
sheet's visible scrolling viewport, excluding the keyboard suggestion bar.

At the Loop43 boundary, explicit HTTPS input was still downgraded by the shared
parser; Loop44 addresses that separate transport issue below. Ordinary iOS sends
still clear the draft before acceptance, and the live Always allow chain needs
same-context/error fencing across grant and response. Welcome-card verification
does not close those action issues. The Loop43 fixture and simulator were fully
stopped, with32/32 cleanup checks and all16 pre-existing devices preserved.


## Companion address and transport contract — Loop44

The shared iOS/Watch client preserves the scheme shown during pairing and in
Settings. Use the exact address from the computer's Companion panel. HTTPS needs
a TLS endpoint that serves the companion API directly; this client change does
not add TLS to the computer's default HTTP listener.

| Entered address | Result |
|---|---|
| `https://computer.example` | HTTPS, port443 |
| `http://computer.example` | HTTP, port80 |
| `computer.local` | Legacy companion HTTP, port8810 |
| `https://computer.example:8443` | HTTPS, explicit port8443 |
| `[::1]:8810` | IPv6 companion HTTP, explicit port8810 |

Saved connections without a scheme retain HTTP and the original persisted ID,
name, host and port, preserving Keychain lookup. New records include the scheme.
Malformed saved schemes fail instead of silently becoming HTTP. Input rejects
credentials, non-root paths, queries, fragments, unsupported schemes, malformed
ports/authorities and ambiguous numeric IPv4 forms. ASCII DNS/punycode, ordinary
IPv4 and bracketed IPv6 (including scope zones) are supported; raw Unicode DNS
names are not accepted by this parser.

Pairing, REST and SSE refuse every redirect, including a new path on the same
origin. A redirect error asks for the direct server address. There is no automatic
HTTPS-to-HTTP fallback, mutation replay or redirect-token forwarding. Per-task
policy also applies with an injected ordinary URLSession; background session
configurations are rejected before requests start. The app leaves certificate
validation to the operating system. A deliberately supplied session's separate
authentication delegate remains the caller's responsibility.

ATS configuration values are unchanged. NSAllowsLocalNetworking is not a private
IP-subnet allowlist; its OS-version behavior and local-network privacy are separate
checks. Test the actual supported OS/device/network combination before making
release claims. See [Apple's ATS documentation](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking)
and [redirect callback semantics](https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate/urlsession(_:task:willperformhttpredirection:newrequest:completionhandler:)).


Loop44 verification on2026-09-11: **189 Swift core tests passed**, with no failures
or skips (0.664s; previous161). Root Vitest separately passed **235files /3241tests
/8skipped** in257.68s. iOS local ad hoc simulator and Watch unsigned simulator
builds succeeded. These do not establish Watch runtime or distribution readiness.

The fresh iPhoneSE3/iOS26.5 acceptance used the actual native app, Keychain,
companion proxy/DeviceRegistry/server and REST/SSE. A generated test CA was trusted
only inside that disposable simulator; the app used ordinary OS certificate
validation. Valid HTTPS pairing, authenticated REST/SSE, cold identity restore,
explicit HTTP compatibility, pairing redirects, authenticated redirects/recovery,
and expired/wrong-host/untrusted certificate rejection were exercised.

Counts are **6 passed /1 failed in the initial seven-case native run**, then
**1 passed /0 failed in the targeted expired-certificate rerun**. The initial
failure was before a network request: delayed discovery help moved Continue
behind the keyboard. The rerun waits for that layout to settle and scrolls
virtualized form controls into view. All seven distinct transport scenarios have
passing evidence; there was no single all-green seven-case run. Do not turn this
into a claim that the pairing interface is fully verified. The certificate-error
screenshot also shows the lower error text partly behind the number keyboard.
Remove delayed form movement and make the complete error readable next.

Evidence and failed runs are in `.omb-scratch/verification/loop44-native-transport/`;
its source snapshot records69 non-Markdown inputs (68 byte-identical after acceptance; Connection
only loses one redundant final blank line, recorded in verification.json).
The companion fixture is in `loop44-native-tls/`. All39 cleanup checks passed:
11ports closed, owned processes absent, the test simulator and its trust store
deleted, all26 pre-existing simulators preserved. No shared Mac trust change was
made. Physical devices, minimum iOS17 runtime, Watch runtime, Google and native
release signing remain separate gates.


## iPhone pairing form and operation contract — Loop45

Manual address entry precedes the changing discovery results. Troubleshooting is
an explicit disclosure; no timer inserts help above the form while someone types.
Address/code fields expose a keyboard Done action. Validation and request errors
clear focus and use a native alert so the entire message can be read without the
number keyboard covering its final lines. Failed addresses remain editable;
failed one-time codes are cleared and require an explicit fresh attempt.

Submission captures the computer and credential and locks synchronously before
scheduling its Task. A successful attempt remains locked until navigation removes
the pairing view; only a matching failure unlocks it. The manual, discovery and
scanner paths invalidate older selections. A link arriving during a pending
attempt is consumed with an explanatory notice, never queued or redeemed later.
The scanner callback also belongs to its specific opening. These UI checks do not
replace Session's existing connection fencing or the server's one-time registry.

Owned native acceptance must assert complete control/message bounds, not merely
XCTest `isHittable` or accessibility existence. On iOS26.5 the floating keyboard
toolbar can intercept a gesture whose coordinate appears above the keyboard keys.
Scroll from a clear part of the form before tapping. Preserve failed runs; a test
that stopped before submission cannot establish transport or retry behavior.

Loop45 verified on2026-09-11: root **235files /3241passed /8skipped** (277.25s),
Swift **189passed /0failed** (0.743s), ad hoc iPhoneSE3/iOS26.5 build,
servertsc/rootlint exit0, and69 matching non-Markdown source inputs. **Six distinct
native scenarios passed across reruns**: stable manual controls, invalid-address
retention, certificate error visibility, explicit server-error retry with cold
Keychain restoration, repeated tap/competing live invitation, and invitation
confirmation. Earlier failed batches and individual runs remain in `failed-runs.json`;
there was no single all-green six-case native batch. See the Loop45 CEO ledger for
individual times and initial failures.

For a link arriving during an existing request, `XCUIApplication.open` relaunches
the app. The accepted case instead uses an owned-host `simctl openurl` bridge and
taps only iOS's exact MusterMobile Open confirmation. Keep the original pairing
window: opening another invalidates its credential. Assert one original request,
its open connection, release1live/0abandoned, and one redemption. A pre-redemption
hold or503 does not establish accepted-response-loss behavior. Real camera capture,
Bonjour arrival, physical/iOS17/Watch devices and Google remain separate gates.

Cleanup retained an initial25passed/1failed shutdown-status gate (`kill EPERM`,
launcherexit1), then independently passed37/37 recovery checks plus6/6 URL-bridge
cleanup checks. All owned processes/ports are gone, the disposable simulator/testCA
is deleted, all26 pre-existing devices are unchanged, and evidence is preserved.
Artifacts: `.omb-scratch/verification/loop45-ios-pairing/` and
`loop45-native-pairing/`. These simulator checks do not establish distribution or
cross-platform release readiness.


## Ordinary composer acceptance — Loop 46 (2026-09-11)

236 root files / 3257 passed / 8 skipped, 287.63s; 222 Swift passed / 0 failed, 0.957s; 33 focused composer tests; 42/42 final-runtime HTTP checks, 2.472s; 7/7 native scenarios, 353.518s; cleanup 67/67 checks. Server typecheck, root lint and ad hoc iPhoneSE3/iOS26.5 build passed.
The actual app uses an isolated Keychain and simulator-only CA, real server/proxy
and an offline provider. Seven native cases cover bot/room acceptance,503/manual
retry, duplicate taps/newer edits, navigation/cancellation, accepted-response loss,
and an old desktop's health response. Root evidence and all failures are retained
under `.omb-scratch/verification/loop46-ios-composer/`; see the Loop46 CEO ledger.

`ChatView` routes ordinary sends through the separate `ComposerCoordinator` and
`ComposerTransport`. Capture the original displayed thread, paired client and
edit revision synchronously. Only a valid202 receipt for that thread may clear
that revision. Preflight `messageSendVersion: 1` on the same authenticated client;
older hosts get update guidance and no POST. On uncertainty, preserve raw text,
show recovery and require the person to check the conversation before retrying.
Never infer acceptance from matching SSE text. Guard the full encoded JSON body
at1,000,000bytes. Watch legacy sends and seed-card actions are separate contracts.

Draft retention is within the in-memory paired session, not process restart or
cross-device backup. The server receipt confirms acceptance, not durable SQLite
storage, guaranteed dispatch or idempotency. The final fixture server was
explicitly restarted for the final Zod boundary parser; source hashes and owner
identities are pinned. Initial native6/7 and a discarded fixture cleanup failure
remain documented alongside final7/7 and final cleanup. All26 original simulators
were preserved and the owned simulator/testCA removed. PhysicaliOS17, Watch,
Google sign-in, real models and distributable release are still separate gates.


## Checked live approval operations

Run `swift test --package-path ios` for the portable grant receipt, exact choice mapping and captured-operation regressions. Loop 48 added 45 tests; its full package result was 267 passed. iPhone composition lives in Session and CardView; the existing WatchSession uses separate methods and is not covered by iPhone runtime evidence.

Native acceptance must use a freshly owned simulator and isolated fixture, with a simulator-only CA and real companion pairing. Verify strict success, grant failure with zero follow-up response, partial-save/unavailable recovery, double taps, view retirement between requests and malformed receipts. Check complete recovery text and 44-point minimum controls on the actual screen. Keep request IDs exact, permit only known permission choices, and never infer acceptance from SSE alone.

Loop 48 verified six distinct scenarios across initial 5 passed / 1 OS setup failure and a targeted 1 passed rerun on the initialized keyboard session. The first-use English/Hindi tutorial can intercept XCTest incorrectly; its failed screenshot and slash insertion are retained. This is an explicit simulator setup limitation, not a proven cold-start fix. Never hide that run or treat it as an approval failure. Exact receipts and screenshots live locally under `.omb-scratch/verification/loop48-approval/` and `loop48-native-approval/`; prior fixture identities and simulator UDIDs have been retired. Google, real tool execution, physical devices, minimum iOS and Watch runtime remain separate acceptance gates.
