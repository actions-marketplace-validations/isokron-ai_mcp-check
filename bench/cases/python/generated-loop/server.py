from mcp.server.fastmcp import FastMCP

mcp = FastMCP("temperatures")


def make_converter(unit: str):
    def convert(value: float) -> float:
        return value

    convert.__doc__ = f"Converts a temperature to {unit}."
    return convert


for unit in ["celsius", "fahrenheit"]:
    mcp.add_tool(make_converter(unit), name=f"to_{unit}")

if __name__ == "__main__":
    mcp.run()
