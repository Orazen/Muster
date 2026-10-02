// swift-tools-version: 5.9
import PackageDescription

// MusterMac (M0): an isolated native Mac prototype against owned fixtures.
//
// The package is deliberately self-contained — no app bundle, no signing, no
// updater, no production endpoints. It consumes the shared CompanionCore
// library from ../ios as a READ-ONLY local package dependency: nothing in
// this package may modify ios/, the server, or any shared workflow. If a
// shared-core change seems necessary, that is a separate slice with its own
// owner, per the native migration plan.
let package = Package(
    name: "MusterMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "MusterMac", targets: ["MusterMac"])
    ],
    dependencies: [
        .package(path: "../ios")
    ],
    targets: [
        // UI-free prototype logic: fixtures, the fleet model, and the
        // explicitly-identified GET-only harness probe. Keeping this target
        // separate is what lets contract tests run without launching a GUI.
        .target(
            name: "MusterMacCore",
            dependencies: [.product(name: "CompanionCore", package: "ios")]
        ),
        .executableTarget(
            name: "MusterMac",
            dependencies: [
                "MusterMacCore",
                .product(name: "CompanionCore", package: "ios"),
            ]
        ),
        .testTarget(
            name: "MusterMacCoreTests",
            dependencies: [
                "MusterMacCore",
                .product(name: "CompanionCore", package: "ios"),
            ]
        ),
        // View-level lifecycle coverage that CI can actually pin. This target
        // depends on the executable target on purpose: SwiftPM allows a test
        // target to link the app module, so the real `SignInView` can be hosted
        // and inspected directly — no source duplication and no `@main` removal,
        // which is what an out-of-repo harness was previously forced to do.
        //
        // Headless render only. It does NOT prove physical multi-window behaviour
        // on real hardware; the human Mac pass remains a separate open gate.
        .testTarget(
            name: "MusterMacUITests",
            dependencies: [
                "MusterMac",
                "MusterMacCore",
                .product(name: "CompanionCore", package: "ios"),
            ]
        ),
    ]
)
