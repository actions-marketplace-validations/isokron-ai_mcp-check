from mcp.server.fastmcp import FastMCP

mcp = FastMCP("orders")


@mcp.tool(name="lookup_order", description="Returns the status and items of an order.")
def _lookup(order_id: str) -> dict:
    return {}


@mcp.tool(name="cancel_order")
def _cancel(order_id: str, reason: str) -> str:
    """Cancels an order that has not shipped yet."""
    return "cancelled"


if __name__ == "__main__":
    mcp.run()
