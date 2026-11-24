package main

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

func handle(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultText(""), nil
}

func main() {
	s := server.NewMCPServer("queue", "1.0.0")
	s.AddTool(mcp.NewTool(ToolEnqueue,
		mcp.WithDescription("Adds a job to the queue."),
		mcp.WithString("payload", mcp.Required(), mcp.Description("Job payload as JSON")),
	), handle)
	s.AddTool(mcp.NewTool(ToolPeek,
		mcp.WithDescription("Shows the next job without removing it."),
		mcp.WithReadOnlyHintAnnotation(true),
	), handle)
	_ = server.ServeStdio(s)
}
