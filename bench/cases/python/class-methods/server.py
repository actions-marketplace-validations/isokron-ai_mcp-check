from mcp.server.fastmcp import FastMCP


class GeoTools:
    def distance_km(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Great-circle distance between two points in kilometres."""
        return 0.0

    def bearing_deg(self, lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Initial bearing from the first point to the second, in degrees."""
        return 0.0


mcp = FastMCP("geo")
geo = GeoTools()
mcp.add_tool(geo.distance_km)
mcp.add_tool(geo.bearing_deg)

if __name__ == "__main__":
    mcp.run()
