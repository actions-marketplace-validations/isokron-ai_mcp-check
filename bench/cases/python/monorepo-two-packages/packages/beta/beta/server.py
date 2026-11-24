from mcp.server.fastmcp import FastMCP

mcp = FastMCP("beta")


@mcp.tool()
def beta_status() -> str:
    """Returns the status of the beta service."""
    return "ok"
