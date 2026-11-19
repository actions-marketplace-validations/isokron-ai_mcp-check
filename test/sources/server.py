from typing import Annotated, Literal, Optional
from pydantic import Field
from mcp.server.fastmcp import FastMCP, Context
from mcp.types import ToolAnnotations

mcp = FastMCP("demo")

@mcp.tool()
def add(a: int, b: int) -> int:
    """Add two numbers"""
    return a + b

@mcp.tool()
async def search(query: str, limit: int = 10) -> list[str]:
    """Search things"""
    return []

@mcp.tool(
    name="delete_note",
    annotations=ToolAnnotations(destructive_hint=True, read_only_hint=False),
)
async def remove(
    note_id: Annotated[str, Field(description="The note id")],
    mode: Literal["soft", "hard"] = "soft",
    reason: Optional[str] = None,
    ctx: Context = None,
) -> str:
    """Delete a note.

    Soft delete moves it to the trash.
    """
    return "ok"
