import mcp.types as types
from mcp.server import Server

server = Server("low")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(name="ll_one", description="first", inputSchema={"type": "object"}),
        types.Tool(name="ll_two", description="second", inputSchema={"type": "object"}, annotations=types.ToolAnnotations(readOnlyHint=True)),
    ]
