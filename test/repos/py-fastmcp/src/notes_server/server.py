from fastmcp import FastMCP

mcp = FastMCP("notes")


@mcp.tool
def add_note(title: str, text: str, pinned: bool = False) -> dict:
    """Adds a note and returns its id.

    Args:
        title: Short title of the note
        text: The note itself
        pinned: Keep the note at the top of the list
    """
    return {"id": "1"}


@mcp.tool(annotations={"readOnlyHint": True})
def list_notes(limit: int = 20) -> list[str]:
    """Lists the titles of the most recent notes."""
    return []


if __name__ == "__main__":
    mcp.run()
