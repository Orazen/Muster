# Install a personal Muster build on your iPhone and Apple Watch

Verified on **12 September 2026** against Apple’s official guidance and the prepared Muster project.

You can use a **free Apple Account and Xcode’s Personal Team** to install a development build on your own devices. Paid Apple Developer Program membership is needed to publish through TestFlight or the App Store, not for this personal Xcode workflow. [Apple: developer accounts](https://developer.apple.com/help/account/basics/about-your-developer-account), [Apple: app distribution](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).

## Open the prepared project

On the Mac where this copy was prepared, open [MusterCompanion.xcodeproj](/Users/ramagiritharun/muster-audit/.omb-scratch/verification/astra-onboarding-refresh-2026-09-12/native-personal/source/ios/MusterCompanion.xcodeproj) in Xcode. Its complete path is:

```text
/Users/ramagiritharun/muster-audit/.omb-scratch/verification/astra-onboarding-refresh-2026-09-12/native-personal/source/ios/MusterCompanion.xcodeproj
```

This project is already generated. It is a separate local testing copy, not a change to the main source checkout. On another Mac, this absolute path will not exist; copy or prepare the complete `source/ios/` directory, including its local CompanionCore package, rather than copying the `.xcodeproj` alone.

Muster requires **iOS 17 or later** and **watchOS 10 or later**. Use an Xcode version that supports the operating systems actually installed on your devices. This copy compiled with Xcode 26.6 and the iOS/watchOS 26.5 simulator SDKs; physical-device compatibility still depends on your particular OS versions.

## What was adjusted for a free account

The normal iPhone target requests **Time Sensitive Notifications**, a capability Apple’s current matrix excludes from free Apple Developer accounts. The test copy removes that declaration from **both** its `ios/project.yml` and its `ios/App/MusterCompanion.entitlements`; otherwise XcodeGen could restore it. The empty entitlement file remains configured. [Apple: supported iOS capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios).

No phone or Watch application code was changed for this adjustment. Ordinary local notification alerts can still be tested with your permission, but this copy does not establish Time Sensitive interruption through Focus. The Watch is a separate standalone target and has no corresponding entitlement. Actual signed entitlements and provisioning profiles should be checked during physical-device setup if Xcode reports a capability mismatch.

## Choose your Personal Team

1. In Xcode, open **Settings → Apple Accounts** (called **Accounts** in some versions) and sign in with your Apple Account.
2. Select the project in the navigator, then the **MusterCompanion** app target. Open **Signing & Capabilities**, enable **Automatically manage signing**, and choose your **Personal Team**.
3. Do the same for the **MusterWatch** app target. No team or provisioning profile has been selected in the prepared copy.
4. Keep the existing bundle identifiers if Xcode can register them for your team. If it reports an ownership or uniqueness error, choose unique development identifiers in this copy. Keep those identifiers consistent for subsequent reinstalls.

Xcode creates the development provisioning profile and registers the selected device as part of this workflow. You do not need to configure distribution signing or App Store Connect for personal testing. [Apple: signing and running on physical devices](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices).

If you later regenerate this project with XcodeGen, record any intended local signing changes in the copy’s spec first; regeneration can replace settings changed only in Xcode.

## Prepare your iPhone and Watch

1. Connect your unlocked iPhone to the Mac by cable and accept **Trust This Computer**.
2. Open Xcode’s device manager and complete its pairing prompts. In Xcode 26, use **Window → Devices and Simulators**; newer Apple documentation calls this **Device Hub / Manage Devices**.
3. On the iPhone, enable **Settings → Privacy & Security → Developer Mode**, restart, then confirm enablement and enter the passcode. The switch may appear only after Xcode initiates pairing.
4. Keep your Watch normally paired with your iPhone. Pair the iPhone with Xcode first, keep the Watch nearby and reachable, and enable **Developer Mode on both devices**. On the Watch, restart and confirm **Turn On** and **Trust** when prompted.
5. Wait until the exact iPhone and Watch you intend to use are available as Xcode run destinations. Follow any device-specific connection instructions there; there is no need to erase or re-pair the Watch as part of these steps.

The cable-first phone setup avoids depending on newer wireless-pairing features that may not exist in your Xcode version. [Apple: Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device), [Apple: managing physical devices](https://developer.apple.com/documentation/xcode/managing-your-simulated-and-physical-devices-in-device-hub).

## Build and run each app

| Device | Xcode scheme | Run destination | App |
| --- | --- | --- | --- |
| iPhone | **MusterOwnedAcceptance** | Your physical iPhone | `MusterCompanion`, displayed as **MusterMobile** |
| Apple Watch | **MusterWatch** | Your physical Watch | **Muster** |

Choose **Product → Run** for each app. The iPhone scheme also contains repository UI tests; **Product → Test is not needed to install and use the app**. Resolve any Xcode signing error before continuing.

The Watch uses `WKWatchOnly: true`: it is not embedded in the iPhone app. Installing MusterMobile therefore does **not** install the Watch app automatically. Run the Watch scheme separately. [Apple: Watch-only app declaration](https://developer.apple.com/documentation/bundleresources/information-property-list/wkwatchonly).

The existing simulator `.app` outputs are for simulators. A physical device needs a new device build with your Personal Team signing; the signing-disabled compile commands in the evidence README are not device-install commands.

## Connect each app to your computer

On the computer, open Muster’s **Companion** settings, enable access, and open a fresh pairing window. In the iPhone app, use the supported invitation/QR flow or enter the displayed computer address and current code. On the Watch, choose the discovered computer or enter its address and code manually.

The iPhone and Watch register separately. After one device consumes a pairing window, open another for the second device. Each must be able to reach the computer’s companion endpoint. `localhost` on the phone or Watch refers to that device, not the Mac. The Watch connects directly to Muster; it does not relay all traffic through the iPhone app.

Begin with a disposable conversation and a simple task you can inspect. The Watch composer’s system-editor/Done and lifecycle behavior remains pending dedicated native acceptance in this source snapshot. Its foreground stream also does not provide an always-running notification service while the Watch app is suspended.

## Renew the free installation

Apple currently allows **10 App IDs, 3 devices, and 3 installed apps per device** for a Personal Team. App IDs and device registrations expire after seven days; development provisioning profiles expire seven days after issuance. Rebuild and run from Xcode again after expiry, using the same team and bundle identifiers. Routine renewal does not require deleting the apps or resetting your devices. [Apple: Personal Team limits](https://developer.apple.com/help/account/basics/about-your-developer-account).

For later TestFlight use, the **publisher** needs paid program membership; an invited external **tester** does not. TestFlight builds can be tested for up to 90 days. A Watch-only TestFlight beta is installed through TestFlight on the iPhone paired with that Watch. This guide does not establish an available Muster TestFlight invitation. [Apple: external testers](https://developer.apple.com/tutorials/develop-in-swift/test-your-beta-app), [Apple: TestFlight installation](https://testflight.apple.com/).

## What has actually been verified

The prepared copy contains 86 source inputs, including five exact preserved Watch/composer replacements, plus four generated project files. Its first authorized sequential simulator compile gates passed:

| Compile gate | Result |
| --- | --- |
| `MusterWatch`, generic watchOS Simulator | Exit 0, **56.211 seconds** |
| `MusterOwnedAcceptance`, generic iOS Simulator | Exit 0, **57.394 seconds** |

All 90 copy inputs, all 86 checkout inputs, all five overlays, and all 26 preexisting simulator identities/states were unchanged. Both builds disabled development signing; the products have only normal linker ad-hoc signatures with no developer-team identity or embedded provisioning profile. No device was installed, booted, or modified, and no runtime tests ran in these gates.

**Compilation is verified. Personal Team provisioning, execution on your physical iPhone/Watch, and the pending Watch composer editor acceptance are not yet verified.** The [prepared-copy README](/Users/ramagiritharun/muster-audit/.omb-scratch/verification/astra-onboarding-refresh-2026-09-12/native-personal/README.md) links the exact input manifests, build logs, result bundles and terminal-process receipts.
