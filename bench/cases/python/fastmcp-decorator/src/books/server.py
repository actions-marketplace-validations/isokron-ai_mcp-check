from mcp.server.fastmcp import FastMCP

mcp = FastMCP("books")


@mcp.tool()
def search_books(query: str, limit: int = 10) -> list[str]:
    """Searches the catalogue by title or author and returns matching book ids."""
    return []


@mcp.tool()
def get_book(book_id: str) -> dict:
    """Returns the details of one book."""
    return {}


if __name__ == "__main__":
    mcp.run()
