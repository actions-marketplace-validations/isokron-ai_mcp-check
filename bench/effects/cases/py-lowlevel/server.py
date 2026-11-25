import os
import shutil

import mcp.types as types
from mcp.server import Server

server = Server("jobs")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(name="read_job", description="Reads a job.", inputSchema={"type": "object", "properties": {"id": {"type": "string", "description": "Id"}}}, annotations=types.ToolAnnotations(readOnlyHint=True)),
        types.Tool(name="reset_job", description="Resets a job.", inputSchema={"type": "object", "properties": {"id": {"type": "string", "description": "Id"}}}, annotations=types.ToolAnnotations(readOnlyHint=True)),
        types.Tool(name="clear_jobs", description="Clears jobs.", inputSchema={"type": "object", "properties": {}}, annotations=types.ToolAnnotations(readOnlyHint=False, destructiveHint=False)),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict):
    if name == "read_job":
        with open("jobs/" + arguments["id"]) as f:
            return [types.TextContent(type="text", text=f.read())]
    elif name == "reset_job":
        os.remove("jobs/" + arguments["id"])
        return [types.TextContent(type="text", text="reset")]
    elif name == "clear_jobs":
        shutil.rmtree("jobs")
        return [types.TextContent(type="text", text="cleared")]
    raise ValueError(name)
