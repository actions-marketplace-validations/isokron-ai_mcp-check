from fastmcp import FastMCP

jira_mcp = FastMCP("jira")


@jira_mcp.tool()
def get_issue(key: str) -> str:
    """Get an issue."""
    return key
