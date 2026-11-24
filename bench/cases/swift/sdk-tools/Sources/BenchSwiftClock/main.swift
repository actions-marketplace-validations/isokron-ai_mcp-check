import MCP

let server = Server(name: "clock", version: "1.0.0", capabilities: .init(tools: .init(listChanged: false)))

await server.withMethodHandler(ListTools.self) { _ in
    .init(tools: [
        Tool(name: "utc_now", description: "Returns the current UTC time.", inputSchema: .object(["type": "object"])),
        Tool(name: "unix_time", description: "Returns the current Unix timestamp.", inputSchema: .object(["type": "object"])),
    ])
}
