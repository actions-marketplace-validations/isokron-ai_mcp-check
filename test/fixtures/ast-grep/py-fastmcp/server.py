from mcp.server.fastmcp import FastMCP

mcp = FastMCP("demo")


@mcp.tool()
def add(a: int, b: int) -> int:
    """Add two numbers.

    More text.
    """
    return a + b


@mcp.tool(name="renamed_tool", description="Explicit description")
async def internal_name(x: str) -> str:
    return x


@mcp.tool
def bare_decorator() -> str:
    """Bare decorator."""
    return ""


@mcp.tool(annotations={"readOnlyHint": True})
def annotated() -> str:
    return ""


@mcp.resource("res://x")
def not_a_tool() -> str:
    return ""


@mcp.tool(name=NAME_CONST)
def dynamic_named() -> str:
    return ""
