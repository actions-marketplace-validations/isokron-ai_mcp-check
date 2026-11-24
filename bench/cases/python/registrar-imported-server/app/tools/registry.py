from app.server import mcp


def create_tool(name: str, description: str):
    def register(fn):
        mcp.tool(fn, name=name, description=description)
        return fn

    return register
