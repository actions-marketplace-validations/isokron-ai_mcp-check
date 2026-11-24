from fastmcp import FastMCP
from fastmcp.tools import (
    tool,
)

mcp = FastMCP("books")


@tool(name="search_books")
def search_books(query: str) -> list[str]:
    """Searches the catalogue by title or author."""
    return []


mcp.add_tool(search_books)

if __name__ == "__main__":
    mcp.run()
