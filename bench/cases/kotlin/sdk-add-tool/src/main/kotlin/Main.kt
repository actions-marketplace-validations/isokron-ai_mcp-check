import io.modelcontextprotocol.kotlin.sdk.CallToolResult
import io.modelcontextprotocol.kotlin.sdk.Implementation
import io.modelcontextprotocol.kotlin.sdk.ServerCapabilities
import io.modelcontextprotocol.kotlin.sdk.TextContent
import io.modelcontextprotocol.kotlin.sdk.Tool
import io.modelcontextprotocol.kotlin.sdk.server.Server
import io.modelcontextprotocol.kotlin.sdk.server.ServerOptions

fun main() {
    val server = Server(Implementation(name = "dice", version = "1.0.0"), ServerOptions(capabilities = ServerCapabilities(tools = ServerCapabilities.Tools(listChanged = false))))
    server.addTool(name = "roll_die", description = "Rolls a six-sided die.", inputSchema = Tool.Input()) {
        CallToolResult(content = listOf(TextContent("4")))
    }
    server.addTool(name = "flip_coin", description = "Flips a coin.", inputSchema = Tool.Input()) {
        CallToolResult(content = listOf(TextContent("heads")))
    }
}
