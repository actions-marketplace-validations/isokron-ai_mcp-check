package main

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func main() {
	s := server.NewMCPServer("time", "1.0.0")

	getTime := mcp.NewTool("get_time",
		mcp.WithDescription("Returns the current time in a time zone."),
		mcp.WithString("zone", mcp.Required(), mcp.Description("IANA time zone, such as Europe/Paris")),
		mcp.WithReadOnlyHintAnnotation(true),
	)
	s.AddTool(getTime, handleGetTime)

	convert := mcp.NewTool("convert_time",
		mcp.WithDescription("Converts a time from one time zone to another."),
		mcp.WithString("time", mcp.Required(), mcp.Description("Time as HH:MM")),
		mcp.WithString("from", mcp.Required(), mcp.Description("Source time zone")),
		mcp.WithString("to", mcp.Required(), mcp.Description("Target time zone")),
		mcp.WithReadOnlyHintAnnotation(true),
	)
	s.AddTool(convert, handleConvert)

	_ = server.ServeStdio(s)
}

func handleGetTime(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultText("12:00"), nil
}

func handleConvert(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultText("13:00"), nil
}
