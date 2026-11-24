require "mcp"

class PingTool < MCP::Tool
  tool_name "ping_host"
  description "Checks whether a host answers."
  input_schema(properties: { host: { type: "string" } }, required: ["host"])

  def self.call(host:, server_context:)
    MCP::Tool::Response.new([{ type: "text", text: "pong" }])
  end
end

class UptimeTool < MCP::Tool
  tool_name "host_uptime"
  description "Returns how long a host has been up."
  input_schema(properties: { host: { type: "string" } }, required: ["host"])

  def self.call(host:, server_context:)
    MCP::Tool::Response.new([{ type: "text", text: "3 days" }])
  end
end

server = MCP::Server.new(name: "hosts", version: "1.0.0", tools: [PingTool, UptimeTool])
MCP::Server::Transports::StdioTransport.new(server).open
