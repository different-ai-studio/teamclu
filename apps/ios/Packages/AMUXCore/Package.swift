// swift-tools-version: 6.2
//
// AMUXCore — domain layer.
//
// Allowed: pure models, repositories, services, reducers, use cases,
// SwiftData @Model types, MQTT/Supabase clients, view models. Imports
// SwiftUI only where SwiftData @Model types require it; do not add new
// SwiftUI views to this package — put them in AMUXSharedUI (reusable
// rendering of domain models) or AMUXUI (feature screens).
//
// AMUXCore must not depend on AMUXSharedUI or AMUXUI. Doing so creates
// a cycle.
//
import PackageDescription

let package = Package(
    name: "AMUXCore",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "AMUXCore", targets: ["AMUXCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/emqx/CocoaMQTT.git", from: "2.2.3"),
        .package(url: "https://github.com/apple/swift-protobuf.git", from: "1.36.1"),
    ],
    targets: [
        .target(
            name: "AMUXCore",
            dependencies: [
                .product(name: "CocoaMQTT", package: "CocoaMQTT"),
                .product(name: "SwiftProtobuf", package: "swift-protobuf"),
            ],
            resources: [.process("Resources")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "AMUXCoreTests",
            dependencies: ["AMUXCore"],
            resources: [.process("Resources")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
