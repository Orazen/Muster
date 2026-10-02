// The first screen a new phone sees — the GAIA-style welcome.
//
// Two steps, in the order trust actually flows: claim a cloud identity
// (Google sign-in through the same handoff the desktop uses), then pair
// with your computer (the event stream's real trust root). The pairing
// step is where data starts moving; sign-in is identity, and the screen
// never pretends otherwise.
//
// The approved native presentation uses solid adaptive surfaces, restrained
// blue controls and the orange Flower. System text sizes and scrolling keep
// sign-in and pairing available at accessibility text sizes.
//
// Routing contract: RootView shows this only when unpaired AND
// `session.welcomeSeen` is false; a pairing deep link (muster://pair…)
// always wins and lands in PairingView directly, so owned UI tests and
// real invite links never meet this screen unless the user actually
// launches the app cold. Both buttons complete onboarding by flipping
// `session.welcomeSeen` — RootView does the routing.
import SwiftUI

struct WelcomeView: View {
    @EnvironmentObject private var session: Session
    @ObservedObject private var cloud = CloudAuth.shared

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                hero.frame(minHeight: geometry.size.height)
            }
            .background(MusterPalette.canvas.ignoresSafeArea())
        }
        // A pairing invite can arrive while the hero is up (deep link at
        // launch, or the desktop re-sent an invite). Intent beats onboarding:
        // flipping welcomeSeen lets RootView route to PairingView.
        .onChange(of: session.pairingInvite) { _, invite in
            if invite != nil { session.welcomeSeen = true }
        }
    }

    private var hero: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)

            FlowerAvatar(color: "orange", size: 128, state: "idle", seed: "welcome")
                .frame(width: 128, height: 128)
                .padding(.bottom, 28)
                .accessibilityHidden(true)

            Text("Muster")
                .font(.largeTitle.weight(.semibold))
                .foregroundStyle(.primary)
                .accessibilityIdentifier("welcome-title")
            Text("Your assistant, wherever you are.")
                .font(.body)
                .foregroundStyle(MusterPalette.secondaryInk)
                .padding(.top, 6)
                .multilineTextAlignment(.center)

            Spacer(minLength: 16)

            VStack(spacing: 14) {
                if cloud.isSignedIn {
                    signedInCard
                } else {
                    googleButton
                }
                pairButton
                Button {
                    session.welcomeSeen = true
                } label: {
                    Text("Skip for now")
                        .font(.footnote)
                        .foregroundStyle(MusterPalette.secondaryInk)
                        .padding(.vertical, 8)
                        .padding(.horizontal, 16)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("welcome-skip")
            }
            .padding(.horizontal, 24)

            if let error = cloud.error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(MusterPalette.errorInk)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
                    .padding(.top, 12)
                    .accessibilityIdentifier("welcome-error")
            }

            Spacer(minLength: 32)
        }
    }

    private var googleButton: some View {
        Button {
            cloud.startSignIn()
        } label: {
            HStack(spacing: 10) {
                if cloud.signingIn {
                    ProgressView().tint(MusterPalette.accent)
                } else {
                    GoogleGlyph()
                        .frame(width: 18, height: 18)
                }
                Text(cloud.signingIn ? "Signing in…" : "Continue with Google")
                    .font(.headline)
                    .foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 52)
            .glassSheet(cornerRadius: 14)
        }
        .buttonStyle(.plain)
        .disabled(cloud.signingIn)
        .accessibilityIdentifier("welcome-google")
    }

    private var signedInCard: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color(red: 0.30, green: 0.85, blue: 0.55))
            VStack(alignment: .leading, spacing: 2) {
                Text("Signed in")
                    .font(.footnote)
                    .foregroundStyle(MusterPalette.secondaryInk)
                Text(cloud.identity?.email ?? "")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
        }
        .padding(.horizontal, 18)
        .frame(maxWidth: .infinity, minHeight: 52)
        .glassSheet(cornerRadius: 14)
        .accessibilityIdentifier("welcome-signed-in")
    }

    private var pairButton: some View {
        Button {
            session.welcomeSeen = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "rectangle.landscape.rotate")
                Text("Pair with your computer")
                    .font(.headline)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 52)
            .foregroundStyle(.white)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(MusterPalette.accent)
            )
        }
        .accessibilityIdentifier("welcome-pair")
    }
}

/// The four-color Google "G", drawn — no image asset to keep in sync.
struct GoogleGlyph: View {
    var body: some View {
        GeometryReader { geo in
            let s = geo.size.width
            Path { p in
                // The G's open arc: blue horseshoe with a red top segment.
                p.addArc(center: CGPoint(x: s / 2, y: s / 2), radius: s * 0.42,
                         startAngle: .degrees(-35), endAngle: .degrees(210), clockwise: false)
            }
            .stroke(Color(red: 0.26, green: 0.52, blue: 0.96), lineWidth: s * 0.16)
            Path { p in
                p.addArc(center: CGPoint(x: s / 2, y: s / 2), radius: s * 0.42,
                         startAngle: .degrees(145), endAngle: .degrees(205), clockwise: false)
            }
            .stroke(Color(red: 0.93, green: 0.26, blue: 0.21), lineWidth: s * 0.16)
            Path { p in
                // The bar: blue horizontal into the bowl.
                p.move(to: CGPoint(x: s * 0.93, y: s * 0.5))
                p.addLine(to: CGPoint(x: s * 0.52, y: s * 0.5))
            }
            .stroke(Color(red: 0.26, green: 0.52, blue: 0.96), lineWidth: s * 0.16)
        }
        .accessibilityHidden(true)
    }
}
