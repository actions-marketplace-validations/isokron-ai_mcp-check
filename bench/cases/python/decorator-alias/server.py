from mcp.server.fastmcp import FastMCP

app = FastMCP("units")
tool = app.tool


@tool()
def to_metres(feet: float) -> float:
    """Converts feet to metres."""
    return feet * 0.3048


@tool()
def to_feet(metres: float) -> float:
    """Converts metres to feet."""
    return metres / 0.3048


if __name__ == "__main__":
    app.run()
