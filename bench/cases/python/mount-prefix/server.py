from fastmcp import FastMCP

weather = FastMCP("weather")


@weather.tool
def forecast(city: str) -> str:
    """Returns tomorrow's forecast for a city."""
    return "sunny"


main = FastMCP("main")


@main.tool
def status() -> str:
    """Returns the status of the service."""
    return "ok"


main.mount(weather, prefix="weather")

if __name__ == "__main__":
    main.run()
