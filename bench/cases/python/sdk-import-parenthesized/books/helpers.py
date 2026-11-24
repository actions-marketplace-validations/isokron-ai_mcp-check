def tool(name, description):
    """Builds a row for the admin page's tool table (not an MCP tool)."""
    return {"name": name, "description": description, "inputSchema": {"type": "object"}}
