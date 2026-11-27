from fastmcp import FastMCP
from .jira import jira_mcp

main_mcp = FastMCP("main")
main_mcp.mount("jira", jira_mcp)
