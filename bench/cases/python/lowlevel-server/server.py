import mcp.types as types
from mcp.server.lowlevel import Server

server = Server("inventory")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="count_stock",
            description="Returns the stock count of a product.",
            inputSchema={"type": "object", "properties": {"sku": {"type": "string", "description": "Product code"}}, "required": ["sku"]},
            annotations=types.ToolAnnotations(readOnlyHint=True),
        ),
        types.Tool(
            name="reserve_stock",
            description="Reserves units of a product for an order.",
            inputSchema={"type": "object", "properties": {"sku": {"type": "string"}, "units": {"type": "integer", "minimum": 1}}, "required": ["sku", "units"]},
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    return []
