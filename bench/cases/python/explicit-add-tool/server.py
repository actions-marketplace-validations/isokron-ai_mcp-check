from mcp.server.fastmcp import FastMCP

mcp = FastMCP("convert")


def convert_currency(amount: float, source: str, target: str) -> float:
    """Converts an amount between two currencies at today's rate."""
    return amount


def list_currencies() -> list[str]:
    """Lists the supported currency codes."""
    return []


mcp.add_tool(convert_currency)
mcp.add_tool(list_currencies, name="supported_currencies")

if __name__ == "__main__":
    mcp.run()
