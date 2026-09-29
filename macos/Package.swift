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
    platforms: [.macOS(.v13)],
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
    ]
)
