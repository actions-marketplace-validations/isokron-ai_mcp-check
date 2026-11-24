from fastmcp import FastMCP

mcp = FastMCP("notes")


def main() -> None:
    from app.tools import notes  # noqa: F401  registers the tools

    mcp.run()
