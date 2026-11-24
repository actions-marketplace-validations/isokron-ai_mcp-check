// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "BenchSwiftClock",
    dependencies: [.package(url: "https://github.com/modelcontextprotocol/swift-sdk.git", from: "0.10.0")],
    targets: [.executableTarget(name: "BenchSwiftClock", dependencies: [.product(name: "MCP", package: "swift-sdk")])]
)
