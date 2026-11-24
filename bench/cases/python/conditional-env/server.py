import os

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("accounts")


@mcp.tool()
def get_account(account_id: str) -> dict:
    """Returns one account."""
    return {}


if os.environ.get("ACCOUNTS_ADMIN") == "1":

    @mcp.tool()
    def close_account(account_id: str) -> str:
        """Closes an account. Its data is kept for 30 days."""
        return "closed"


if __name__ == "__main__":
    mcp.run()
