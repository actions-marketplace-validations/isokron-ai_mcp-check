from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

mcp = FastMCP("users")


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def delete_user(user_id: str) -> str:
    """Deletes a user account."""
    return "deleted"


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False))
def remove_member(team_id: str, user_id: str) -> str:
    """Removes a user from a team."""
    return "removed"


@mcp.tool(annotations=ToolAnnotations(readOnlyHint=True))
def list_members(team_id: str) -> list[str]:
    """Lists the members of a team."""
    return []


if __name__ == "__main__":
    mcp.run()
