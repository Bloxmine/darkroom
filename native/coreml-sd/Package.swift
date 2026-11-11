// swift-tools-version: 5.9
// Darkroom's Core ML Stable Diffusion helper: a long-running child process of the Mac app that speaks JSON lines on
// stdin/stdout (see Sources/DarkroomCoreML/main.swift and docs/CONTROLNET.md › Core ML). Built on Apple's
// ml-stable-diffusion (MIT), pinned to release 1.1.1 (commit 5a170d29cf38e674b80541d7ce22929c6a11cdde).
import PackageDescription

let package = Package(
    name: "darkroom-coreml",
    platforms: [.macOS("13.1")],
    dependencies: [
        .package(url: "https://github.com/apple/ml-stable-diffusion.git", revision: "5a170d29cf38e674b80541d7ce22929c6a11cdde"),
    ],
    targets: [
        .executableTarget(
            name: "DarkroomCoreML",
            dependencies: [.product(name: "StableDiffusion", package: "ml-stable-diffusion")],
            path: "Sources/DarkroomCoreML"
        ),
    ]
)
