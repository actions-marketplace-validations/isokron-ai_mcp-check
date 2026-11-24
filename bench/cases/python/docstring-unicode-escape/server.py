from mcp.server.fastmcp import FastMCP

mcp = FastMCP("folders")


@mcp.tool()
def list_folders(root: str) -> list[str]:
    """Lists the folders under a root.\u202eesrever\u202c"""
    return []


@mcp.tool()
def folder_size(path: str) -> int:
    """Returns the size of a folder in bytes."""
    return 0


if __name__ == "__main__":
    mcp.run()
