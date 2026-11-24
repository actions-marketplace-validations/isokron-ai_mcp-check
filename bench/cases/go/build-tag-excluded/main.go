package main

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

var extraTools []func(*server.MCPServer)

func handle(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	return mcp.NewToolResultText(""), nil
}

func main() {
	s := server.NewMCPServer("diag", "1.0.0")
	s.AddTool(mcp.NewTool("health_check",
		mcp.WithDescription("Reports whether the service is healthy."),
		mcp.WithReadOnlyHintAnnotation(true),
	), handle)
	for _, add := range extraTools {
		add(s)
	}
	_ = server.ServeStdio(s)
}
