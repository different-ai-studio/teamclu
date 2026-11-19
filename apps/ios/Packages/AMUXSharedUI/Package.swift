// swift-tools-version: 6.2
//
// AMUXSharedUI — reusable SwiftUI views over AMUXCore models.
//
// Allowed: leaf views, theme tokens, atomic components that render
// AMUXCore types directly. May depend on AMUXCore.
//
// Do not put feature screens or composition state here — those live in
// AMUXUI. Do not import AMUXUI (it imports us; the reverse creates a
// cycle).
//
import PackageDescription

let package = Package(
    name: "AMUXSharedUI",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "AMUXSharedUI", targets: ["AMUXSharedUI"]),
    ],
    dependencies: [
        .package(path: "../AMUXCore"),
        // Block-level CommonMark + GFM renderer for SwiftUI. Apple's
        // AttributedString markdown only handles inline syntax, so
        // headings / tables / lists / code blocks landed as raw text
        // in the chat bubble until this dependency went in.
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui.git", from: "2.4.0"),
    ],
    targets: [
        .target(
            name: "AMUXSharedUI",
            dependencies: [
                "AMUXCore",
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
            ]
        ),
        .testTarget(
            name: "AMUXSharedUITests",
            dependencies: ["AMUXSharedUI"]
        ),
    ]
)
