from mcp.server.fastmcp import FastMCP

mcp = FastMCP("alpha")


@mcp.tool()
def alpha_status() -> str:
    """Returns the status of the alpha service."""
    return "ok"
